import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Gamepad2, Link2, Loader2, Play, Plus } from "lucide-react";
import type { ProjectEntry, RoxlitConfig } from "@/lib/types";

interface PlacesPanelProps {
  activePath: string;
  fallbackProjects: ProjectEntry[];
  isRunning: boolean;
  /** Switch to another game (stops the current one). */
  onSwitch: (project: ProjectEntry) => void | Promise<void>;
  /** Start Rojo for the active game; opens Studio on its place when one is linked. */
  onStart: () => void;
  /** Create a new game from just its name. */
  onCreateGame: (name: string) => Promise<void>;
  /** Called once a game has been opened, to jump to the Agents chat. */
  onOpened: () => void;
}

export function PlacesPanel({
  activePath,
  fallbackProjects,
  isRunning,
  onSwitch,
  onStart,
  onCreateGame,
  onOpened,
}: PlacesPanelProps) {
  const [projects, setProjects] = useState<ProjectEntry[]>(fallbackProjects);
  const [linking, setLinking] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ path: string; text: string; error: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreate() {
    const name = newName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setCreateError(null);
    try {
      await onCreateGame(name);
      setNewName("");
      setCreating(false);
      await refresh();
      onOpened();
    } catch (err) {
      setCreateError(String(err));
    } finally {
      setCreateBusy(false);
    }
  }

  // The config on disk is the source of truth: it holds the linked places.
  async function refresh() {
    try {
      const config = await invoke<RoxlitConfig | null>("load_config");
      if (config) setProjects(config.projects);
    } catch {
      // keep what we have
    }
  }

  useEffect(() => {
    refresh();
  }, [activePath, isRunning]);

  async function handleOpen(project: ProjectEntry) {
    if (busy) return;
    setBusy(project.path);
    setNote(null);
    try {
      const isActive = project.path === activePath;
      if (!isActive) {
        await onSwitch(project);
      }
      if (!isActive || !isRunning) {
        // Starting development opens Studio on the linked place by itself,
        // but only when Studio is closed — so always ask for the place too.
        onStart();
      }
      if (project.placeId) {
        await invoke("open_place_in_studio", { projectPath: project.path });
        setNote({
          path: project.path,
          text: "Studio s'ouvre sur cette place.",
          error: false,
        });
      } else {
        setNote({
          path: project.path,
          text: "Ouvre ta place dans Studio : elle se connecte et se lie toute seule.",
          error: false,
        });
      }
      onOpened();
    } catch (err) {
      setNote({ path: project.path, text: String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  async function handleLink(project: ProjectEntry) {
    if (!draft.trim() || busy) return;
    setBusy(project.path);
    setNote(null);
    try {
      await invoke("link_place", { projectPath: project.path, placeInput: draft });
      setDraft("");
      setLinking(null);
      await refresh();
      setNote({ path: project.path, text: "Place liée.", error: false });
    } catch (err) {
      setNote({ path: project.path, text: String(err), error: true });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="grid grid-cols-2 gap-3">
        {projects.map((project) => {
          const isActive = project.path === activePath;
          const isBusy = busy === project.path;
          return (
            <div
              key={project.path}
              className={`flex flex-col rounded-lg border p-3 transition-colors ${
                isActive
                  ? "border-emerald-500/40 bg-emerald-500/[0.06]"
                  : "border-white/10 bg-white/[0.03]"
              }`}
            >
              <div className="flex items-start gap-2.5">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-white/[0.06] text-zinc-300">
                  <Gamepad2 className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <span className="truncate">{project.name}</span>
                    {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                  </div>
                  <div className="truncate text-[11px] text-zinc-500">
                    {project.placeId ? `Place ${project.placeId}` : "Aucune place liée"}
                  </div>
                </div>
              </div>

              {linking === project.path ? (
                <div className="mt-3 flex gap-1.5">
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleLink(project);
                      if (e.key === "Escape") setLinking(null);
                    }}
                    placeholder="Lien du jeu ou numéro de place"
                    className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/40"
                  />
                  <button
                    onClick={() => handleLink(project)}
                    disabled={!draft.trim() || isBusy}
                    className="rounded-md bg-emerald-500 px-2.5 text-xs font-semibold text-black disabled:opacity-40"
                  >
                    OK
                  </button>
                </div>
              ) : (
                <div className="mt-3 flex gap-1.5">
                  <button
                    onClick={() => handleOpen(project)}
                    disabled={busy !== null}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-emerald-500 py-1.5 text-xs font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-50"
                  >
                    {isBusy ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    Ouvrir
                  </button>
                  <button
                    onClick={() => {
                      setLinking(project.path);
                      setDraft("");
                      setNote(null);
                    }}
                    className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 text-xs text-zinc-300 transition-colors hover:bg-white/[0.06]"
                    title="Choisir la place Roblox de ce jeu"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {project.placeId ? "Changer" : "Lier"}
                  </button>
                </div>
              )}

              {note?.path === project.path && (
                <p
                  className={`mt-2 text-[11px] leading-snug ${
                    note.error ? "text-red-400" : "text-zinc-400"
                  }`}
                >
                  {note.text}
                </p>
              )}
            </div>
          );
        })}

        {creating ? (
          <div className="flex min-h-[104px] flex-col justify-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-3">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              disabled={createBusy}
              placeholder="Nom du jeu"
              className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/40"
            />
            <button
              onClick={handleCreate}
              disabled={!newName.trim() || createBusy}
              className="flex items-center justify-center gap-1.5 rounded-md bg-emerald-500 py-1.5 text-xs font-semibold text-black disabled:opacity-40"
            >
              {createBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {createBusy ? "Création..." : "Créer"}
            </button>
            {createError && <p className="text-[11px] text-red-400">{createError}</p>}
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="flex min-h-[104px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/10 text-xs text-zinc-500 transition-colors hover:border-white/20 hover:text-zinc-300"
          >
            <Plus className="h-4 w-4" />
            Nouveau jeu
          </button>
        )}
      </div>
    </div>
  );
}
