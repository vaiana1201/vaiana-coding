import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  GitCommitHorizontal,
  Loader2,
  Play,
  Plus,
  Send,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { MAX_AGENTS, useAgents } from "@/hooks/useAgents";
import type { RojoStatus } from "@/lib/types";

interface GitInfo {
  isRepo: boolean;
  changedFiles: number;
  lastCommit: string | null;
}

const PLAYTEST_PROMPT = `Fais un playtest automatique du jeu dans Roblox Studio avec les outils MCP :
1. Lance le playtest.
2. Lis les logs et la sortie de Studio.
3. Pour chaque erreur ou warning lié à nos scripts, trouve la cause et corrige le fichier.
4. Relance le playtest pour vérifier.
Répète jusqu'à ce qu'il n'y ait plus d'erreur (5 tours maximum), puis arrête le playtest et résume ce que tu as corrigé.`;

/** Starters that use Roblox Studio's own generation tools through the Studio MCP. */
const CREATE_PRESETS: { label: string; text: string }[] = [
  {
    label: "Map",
    text: "Construis cette map dans Roblox Studio avec les outils de génération de Studio (scène, terrain, modèles), puis montre-moi une capture : ",
  },
  {
    label: "Modèle 3D",
    text: "Génère ce modèle 3D avec l'outil de génération de mesh de Studio et place-le dans Workspace : ",
  },
  {
    label: "Texture",
    text: "Génère cette texture ou ce matériau avec les outils de Studio et applique-le sur la sélection : ",
  },
  {
    label: "Animation",
    text: "Génère cette animation avec l'outil d'animation de Studio et branche-la sur le personnage : ",
  },
];

const BLENDER_PRESET =
  "Modélise ceci dans Blender (low-poly, prêt pour Roblox), exporte le FBX et montre-moi où il est : ";

interface AgentsPanelProps {
  projectPath: string;
  rojoStatus: RojoStatus;
}

export function AgentsPanel({ projectPath, rojoStatus }: AgentsPanelProps) {
  const { agents, activeId, setActiveId, addAgent, removeAgent, send, stop } =
    useAgents(projectPath);
  const [draft, setDraft] = useState("");
  const [git, setGit] = useState<GitInfo | null>(null);
  const [gitBusy, setGitBusy] = useState(false);
  const [gitNote, setGitNote] = useState<string | null>(null);
  // undefined = still checking, null = not installed, string = path of blender.exe
  const [blender, setBlender] = useState<string | null | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const active = agents.find((a) => a.id === activeId) ?? agents[0];
  const busyCount = agents.filter((a) => a.busy).length;
  // Studio can only run one playtest at a time, whoever asked for it.
  const playtester = agents.find((a) => a.playtesting) ?? null;

  async function refreshGit() {
    try {
      setGit(await invoke<GitInfo>("git_info", { projectPath }));
    } catch {
      setGit(null);
    }
  }

  // Refresh the Git status when the project changes and whenever an agent finishes.
  useEffect(() => {
    refreshGit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, busyCount]);

  useEffect(() => {
    invoke<string | null>("detect_blender")
      .then(setBlender)
      .catch(() => setBlender(null));
  }, []);

  // Keep the conversation scrolled to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.messages.length, activeId]);

  function handleSend() {
    if (!active || active.busy || !draft.trim()) return;
    send(active.id, draft);
    setDraft("");
  }

  async function handleCheckpoint() {
    if (gitBusy) return;
    setGitBusy(true);
    setGitNote(null);
    try {
      const stamp = new Date().toLocaleString();
      const result = await invoke<string>("git_checkpoint", {
        projectPath,
        message: `Checkpoint ${stamp}`,
      });
      setGitNote(result === "Saved" ? "Sauvegardé" : "Rien à sauvegarder");
    } catch (err) {
      setGitNote(String(err));
    } finally {
      setGitBusy(false);
      refreshGit();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Agent tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2">
        {agents.map((agent) => {
          const isActive = agent.id === active.id;
          return (
            <div
              key={agent.id}
              className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                isActive
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <button
                onClick={() => setActiveId(agent.id)}
                className="flex items-center gap-1.5"
              >
                {agent.busy ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Bot className="h-3 w-3" />
                )}
                {agent.name}
              </button>
              <button
                onClick={() => removeAgent(agent.id)}
                className="text-zinc-500 hover:text-red-400"
                title="Fermer cet agent"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        {agents.length < MAX_AGENTS && (
          <button
            onClick={addAgent}
            className="flex shrink-0 items-center gap-1 rounded-md border border-dashed border-white/10 px-2.5 py-1.5 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
            title="Ajouter un agent qui travaille en parallèle"
          >
            <Plus className="h-3 w-3" />
            Agent
          </button>
        )}
      </div>

      {/* Conversation */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3"
      >
        {active.messages.length === 0 && (
          <p className="text-xs leading-relaxed text-zinc-500">
            Dis à l'agent ce que tu veux dans ton jeu. Il modifie les scripts du
            projet et agit dans Roblox Studio. Ajoute d'autres agents pour
            lancer plusieurs tâches en même temps : chacun travaille de son
            côté, sans attendre les autres.
            {rojoStatus !== "running" && (
              <span className="mt-2 block text-yellow-400/80">
                Rojo est arrêté : lance « Start Development » dans l'onglet
                Launcher pour que les changements arrivent dans Studio.
              </span>
            )}
          </p>
        )}
        {active.messages.map((message, index) => {
          if (message.role === "user") {
            return (
              <div key={index} className="flex justify-end">
                <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-emerald-500/15 px-3 py-2 text-sm text-emerald-50">
                  {message.text}
                </div>
              </div>
            );
          }
          if (message.role === "tool") {
            return (
              <div
                key={index}
                className="flex items-center gap-1.5 truncate font-mono text-[11px] text-zinc-500"
              >
                <Wrench className="h-3 w-3 shrink-0" />
                <span className="truncate">{message.text}</span>
              </div>
            );
          }
          if (message.role === "error") {
            return (
              <div
                key={index}
                className="whitespace-pre-wrap rounded-md border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-xs text-red-400"
              >
                {message.text}
              </div>
            );
          }
          return (
            <div
              key={index}
              className="max-w-[92%] whitespace-pre-wrap rounded-lg bg-white/[0.04] px-3 py-2 text-sm text-zinc-200"
            >
              {message.text}
            </div>
          );
        })}
        {active.busy && (
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            {active.name} travaille...
          </div>
        )}
      </div>

      {/* Quick actions */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <button
          onClick={() => send(active.id, PLAYTEST_PROMPT, { playtest: true })}
          disabled={active.busy || playtester !== null}
          className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-zinc-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          title={
            playtester
              ? `${playtester.name} fait déjà un playtest (un seul à la fois dans Studio)`
              : "L'agent lance le jeu, lit les erreurs et les corrige"
          }
        >
          <Play className="h-3 w-3" />
          Playtest auto
        </button>
        <button
          onClick={handleCheckpoint}
          disabled={gitBusy}
          className="flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-zinc-300 transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          title="Enregistre l'état actuel du projet dans Git"
        >
          {gitBusy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <GitCommitHorizontal className="h-3 w-3" />
          )}
          Sauvegarder (Git)
        </button>
        {CREATE_PRESETS.map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              setDraft(preset.text);
              inputRef.current?.focus();
            }}
            className="rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-zinc-300 transition-colors hover:bg-white/[0.06]"
            title="Prépare la demande : complète la description puis envoie"
          >
            {preset.label}
          </button>
        ))}
        <button
          onClick={() => {
            setDraft(BLENDER_PRESET);
            inputRef.current?.focus();
          }}
          disabled={!blender}
          className="rounded-md border border-orange-400/30 bg-orange-400/10 px-2.5 py-1.5 text-orange-200 transition-colors hover:bg-orange-400/20 disabled:opacity-40"
          title={
            blender
              ? `L'agent modélise dans Blender (${blender}) et exporte un FBX`
              : "Blender n'est pas installé sur ce PC : installe-le depuis blender.org puis relance l'app"
          }
        >
          Blender
        </button>
        <span className="truncate text-zinc-500">
          {gitNote ??
            (git === null
              ? "Git introuvable"
              : !git.isRepo
                ? "Pas encore de sauvegarde Git"
                : `${git.changedFiles} fichier(s) modifié(s)${
                    git.lastCommit ? ` · dernier : ${git.lastCommit}` : ""
                  }`)}
        </span>
      </div>

      {/* Input */}
      <div className="mt-2 flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          rows={2}
          placeholder={`Message pour ${active.name} (Entrée pour envoyer)`}
          className="min-h-0 flex-1 resize-none rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-500/40"
        />
        {active.busy ? (
          <button
            onClick={() => stop(active.id)}
            className="flex h-10 items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 text-sm font-semibold text-red-400 transition-colors hover:bg-red-500/20"
          >
            <Square className="h-4 w-4" />
            Stop
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!draft.trim()}
            className="flex h-10 items-center gap-1.5 rounded-lg bg-emerald-500 px-3 text-sm font-semibold text-black transition-colors hover:bg-emerald-400 disabled:opacity-40"
          >
            <Send className="h-4 w-4" />
            Envoyer
          </button>
        )}
      </div>
    </div>
  );
}
