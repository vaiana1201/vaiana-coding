import { invoke, Channel } from "@tauri-apps/api/core";
import type {
  DetectionResult,
  InstallConfig,
  ProjectEntry,
  RoxlitConfig,
  SetupEvent,
} from "@/lib/types";

const PARENT_DIR = "~/RobloxProjects";

/** Folder-safe name: "Cloud Empire Tycoon!" -> "cloud-empire-tycoon". */
export function slugify(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "mon-jeu";
}

/** First of name, name-2, name-3... that `isTaken` does not report as used. */
export async function firstFreeName(
  base: string,
  isTaken: (name: string) => Promise<boolean>,
): Promise<string> {
  for (let i = 1; i <= 50; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    if (!(await isTaken(candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export interface PlaceRef {
  placeId: number;
  universeId?: number | null;
}

/**
 * Create a game project with no wizard: default folder, Claude Code as the AI
 * tool, and optionally the Roblox place it belongs to.
 */
export async function createProjectSilently(
  rawName: string,
  place?: PlaceRef,
): Promise<ProjectEntry> {
  const existing = await invoke<RoxlitConfig | null>("load_config").catch(() => null);
  const usedNames = new Set((existing?.projects ?? []).map((p) => p.name));

  const name = await firstFreeName(slugify(rawName), async (candidate) => {
    if (usedNames.has(candidate)) return true;
    // A folder left over from an earlier install also counts as used.
    return invoke<boolean>("check_project_exists", {
      path: `${PARENT_DIR}/${candidate}`,
    }).catch(() => false);
  });
  const projectPath = `${PARENT_DIR}/${name}`;

  const detection = await invoke<DetectionResult>("detect_environment");
  const config: InstallConfig = {
    aiTool: "claude",
    projectPath,
    projectName: name,
    skipAftman: detection.aftmanInstalled,
    skipRojo: detection.rojoInstalled,
    skipRoxlitMcp: detection.roxlitMcpInstalled || detection.os === "linux",
    pluginsPath: detection.studioPluginsPath,
  };

  let failure: string | null = null;
  const channel = new Channel<SetupEvent>();
  channel.onmessage = (event) => {
    if (event.event === "error") failure = event.data.message;
  };
  await invoke("run_installation", { config, onEvent: channel });
  if (failure) throw new Error(failure);

  const entry: ProjectEntry = {
    name,
    path: projectPath,
    aiTool: "claude",
    createdAt: new Date().toISOString(),
    ...(place && place.placeId > 0
      ? { placeId: place.placeId, universeId: place.universeId ?? null }
      : {}),
  };
  const saved = await invoke<RoxlitConfig>("save_project", { project: entry });
  return saved.projects.find((p) => p.name === name) ?? entry;
}

/** The project that should hold a place Studio has open, if one exists already. */
export function findProjectForPlace(
  projects: ProjectEntry[],
  placeId: number,
  activePath: string,
): ProjectEntry | undefined {
  if (placeId > 0) return projects.find((p) => p.placeId === placeId);
  // Unpublished place (id 0): reuse a project that has no place yet.
  return projects.find((p) => !p.placeId && p.path !== activePath);
}
