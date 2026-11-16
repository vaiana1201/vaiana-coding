import { useState, useEffect, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import { invoke } from "@tauri-apps/api/core";
import { Titlebar } from "./components/Titlebar";
import { StepIndicator } from "./components/StepIndicator";
import { Welcome } from "./components/steps/Welcome";
import { SelectTool } from "./components/steps/SelectTool";
import { SelectProject } from "./components/steps/SelectProject";
import { Detecting } from "./components/steps/Detecting";
import { Installing } from "./components/steps/Installing";
import { Complete } from "./components/steps/Complete";
import { Launcher } from "./components/launcher/Launcher";
import { useInstaller } from "./hooks/useInstaller";
import { useLauncher } from "./hooks/useLauncher";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { Recovery } from "./components/steps/Recovery";
import { TOOL_OPTIONS } from "./lib/types";
import type { AppMode, DiscoveredProject, ProjectEntry, RoxlitConfig } from "./lib/types";
import { createProjectSilently, findProjectForPlace } from "./lib/projects";

interface PendingPlace {
  placeId: number;
  universeId: number | null;
  placeName: string | null;
}

export default function App() {
  const [mode, setMode] = useState<AppMode>("loading");
  const [config, setConfig] = useState<RoxlitConfig | null>(null);
  const [updateDelayDays, setUpdateDelayDays] = useState(7);
  const [bootMessage, setBootMessage] = useState<string | null>(null);
  const switchingRef = useRef(false);
  const [discoveredProjects, setDiscoveredProjects] = useState<DiscoveredProject[]>([]);
  const installer = useInstaller();
  const launcher = useLauncher();
  const { update, dismissUpdate } = useUpdateChecker(config);

  // Boot: 3-layer fallback — config → disk scan → wizard
  useEffect(() => {
    async function boot() {
      // Layer 1: Try loading existing config
      try {
        const loadedConfig = await invoke<RoxlitConfig | null>("load_config");
        if (loadedConfig && loadedConfig.projects.length > 0) {
          // Validate that at least one project path still exists on disk
          const validProjects: ProjectEntry[] = [];
          for (const project of loadedConfig.projects) {
            const exists = await invoke<boolean>("check_project_exists", {
              path: project.path,
            });
            if (exists) {
              validProjects.push(project);
            }
          }

          if (validProjects.length > 0) {
            const updatedConfig = { ...loadedConfig, projects: validProjects };
            setConfig(updatedConfig);
            setUpdateDelayDays(updatedConfig.updateDelayDays ?? 7);
            const active =
              validProjects.find(
                (p) => p.path === updatedConfig.lastActiveProject
              ) ?? validProjects[0];
            launcher.setProject(active);
            setMode("launcher");
            return;
          }
          // All project paths are gone — fall through to disk scan
        }
      } catch {
        // Config load failed — fall through to disk scan
      }

      // Layer 2: No valid config. Scan default parent dir for existing projects.
      try {
        const discovered = await invoke<DiscoveredProject[]>(
          "scan_for_projects",
          { parentDir: "~/RobloxProjects" }
        );
        if (discovered.length > 0) {
          setDiscoveredProjects(discovered);
          setMode("recovery");
          return;
        }
      } catch {
        // Scan failed — fall through to installer
      }

      // Layer 3: Nothing found. First-time user — create a first game with
      // default settings instead of asking questions. It gets linked to
      // whichever place is open in Studio on the first "Start Development".
      try {
        setBootMessage("Préparation de ton premier jeu (téléchargement des outils)...");
        const first = await createProjectSilently("mon-jeu");
        const fresh = await invoke<RoxlitConfig | null>("load_config");
        if (fresh) setConfig(fresh);
        launcher.setProject(first);
        setMode("launcher");
        return;
      } catch {
        // Automatic setup failed — fall back to the step-by-step wizard.
      }
      setMode("installer");
    }

    boot();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleGoToLauncher = async (project: ProjectEntry) => {
    launcher.setProject(project);
    setMode("launcher");
    try {
      await invoke("set_active_project", { path: project.path });
    } catch {
      // Non-critical
    }
    // Auto-start development
    setTimeout(() => {
      launcher.startDevelopment();
    }, 300);
  };

  const handleProjectSwitch = async (project: ProjectEntry) => {
    await launcher.stopAll();
    launcher.setProject(project);
    try {
      await invoke("set_active_project", { path: project.path });
    } catch {
      // Non-critical — project switch still works without persisting
    }
  };

  const reloadConfig = async () => {
    const fresh = await invoke<RoxlitConfig | null>("load_config").catch(() => null);
    if (fresh) setConfig(fresh);
    return fresh;
  };

  // Create a game from the "Mes jeux" tab: just a name, no wizard.
  const handleCreateGame = async (name: string) => {
    const project = await createProjectSilently(name);
    await reloadConfig();
    await handleProjectSwitch(project);
    launcher.startDevelopment();
  };

  // Studio has a place open that belongs to another game (or to none yet):
  // switch to that game's project, creating it if needed, then reconnect.
  const handlePendingPlace = async (pending: PendingPlace) => {
    if (switchingRef.current) return;
    switchingRef.current = true;
    try {
      const fresh = await reloadConfig();
      const projects = fresh?.projects ?? [];
      const activePath = launcher.project?.path ?? "";
      let target = findProjectForPlace(projects, pending.placeId, activePath);
      if (!target) {
        target = await createProjectSilently(
          pending.placeName || (pending.placeId > 0 ? `place-${pending.placeId}` : "brouillon"),
          { placeId: pending.placeId, universeId: pending.universeId },
        );
        await reloadConfig();
      }
      await handleProjectSwitch(target);
    } catch {
      // Could not prepare the other game: stay on the current one.
    } finally {
      launcher.startDevelopment();
      switchingRef.current = false;
    }
  };

  const pendingHandlerRef = useRef(handlePendingPlace);
  pendingHandlerRef.current = handlePendingPlace;

  useEffect(() => {
    if (mode !== "launcher") return;
    const timer = setInterval(() => {
      invoke<PendingPlace | null>("take_pending_place")
        .then((pending) => {
          if (pending) pendingHandlerRef.current(pending);
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [mode]);

  const handleNewProject = async () => {
    // Stop running servers before switching to installer
    await launcher.stopAll();
    installer.reset();
    setMode("installer");
  };

  const handleUpdateDelayChange = async (days: number) => {
    setUpdateDelayDays(days);
    setConfig((prev) =>
      prev ? { ...prev, updateDelayDays: days } : prev
    );
    try {
      await invoke("save_settings", { updateDelayDays: days });
    } catch {
      // Silent failure — settings save is non-critical
    }
  };

  const aiToolName =
    TOOL_OPTIONS.find((t) => t.id === installer.aiTool)?.name ??
    "your AI tool";

  // Loading state
  if (mode === "loading") {
    return (
      <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-white/10 bg-[#09090b]">
        <Titlebar />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
            {bootMessage && <p className="text-xs text-zinc-500">{bootMessage}</p>}
          </div>
        </div>
      </div>
    );
  }

  // Launcher mode
  if (mode === "launcher" && launcher.project) {
    return (
      <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-white/10 bg-[#09090b]">
        <Titlebar title="Vaiana Coding" />
        <Launcher
          projectName={launcher.project.name}
          projectPath={launcher.project.path}
          aiTool={launcher.project.aiTool}
          rojoStatus={launcher.rojoStatus}
          rojoPort={launcher.rojoPort}
          logs={launcher.logs}
          error={launcher.error}
          update={update}
          updateDelayDays={updateDelayDays}
          onStartDevelopment={launcher.startDevelopment}
          onStopAll={launcher.stopAll}
          onOpenEditor={launcher.openEditor}
          onNewProject={handleNewProject}
          onDismissUpdate={dismissUpdate}
          onUpdateDelayChange={handleUpdateDelayChange}
          allProjects={config?.projects ?? []}
          onProjectSwitch={handleProjectSwitch}
          onCreateGame={handleCreateGame}
        />
      </div>
    );
  }

  // Recovery mode — config lost but projects found on disk
  if (mode === "recovery") {
    return (
      <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-white/10 bg-[#09090b]">
        <Titlebar title="Vaiana Coding" />
        <Recovery
          discoveredProjects={discoveredProjects}
          onRecovered={(project) => {
            launcher.setProject(project);
            setMode("launcher");
            setTimeout(() => launcher.startDevelopment(), 300);
          }}
          onStartFresh={() => {
            installer.reset();
            setMode("installer");
          }}
          onRescan={(projects) => setDiscoveredProjects(projects)}
        />
      </div>
    );
  }

  // Installer mode
  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-white/10 bg-[#09090b]">
      <Titlebar title="Vaiana Coding" />
      <StepIndicator currentStep={installer.step} />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <AnimatePresence mode="wait">
          {installer.step === "welcome" && (
            <Welcome
              key="welcome"
              onNext={() => installer.goToStep("selectTool")}
            />
          )}

          {installer.step === "selectTool" && (
            <SelectTool
              key="selectTool"
              selected={installer.aiTool}
              onSelect={installer.setAiTool}
              onNext={() => installer.goToStep("selectProject")}
              onBack={() => installer.goToStep("welcome")}
            />
          )}

          {installer.step === "selectProject" && (
            <SelectProject
              key="selectProject"
              projectName={installer.projectName}
              parentDir={installer.projectParentDir}
              fullPath={installer.projectFullPath}
              onNameChange={installer.setProjectName}
              onPickDirectory={installer.pickDirectory}
              onNext={() => installer.goToStep("detecting")}
              onBack={() => installer.goToStep("selectTool")}
            />
          )}

          {installer.step === "detecting" && (
            <Detecting
              key="detecting"
              detection={installer.detection}
              isDetecting={installer.isDetecting}
              onDetect={installer.runDetection}
              onNext={() => installer.goToStep("installing")}
              onBack={() => installer.goToStep("selectProject")}
            />
          )}

          {installer.step === "installing" && (
            <Installing
              key="installing"
              events={installer.installEvents}
              error={installer.installError}
              onInstall={installer.runInstallation}
            />
          )}

          {installer.step === "complete" && (
            <Complete
              key="complete"
              projectPath={installer.projectFullPath}
              projectName={installer.projectName}
              aiTool={installer.aiTool!}
              aiToolName={aiToolName}
              onGoToLauncher={handleGoToLauncher}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
