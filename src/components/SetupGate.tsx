import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { Check, Loader2, LogIn, X } from "lucide-react";
import { Titlebar } from "./Titlebar";

interface Prereqs {
  git: boolean;
  node: boolean;
  claude: boolean;
  canInstall: boolean;
}

type SetupProgress =
  | { event: "step"; data: { tool: string } }
  | { event: "line"; data: { text: string } }
  | { event: "result"; data: { tool: string; ok: boolean } };

type ToolKey = "git" | "node" | "claude";

const TOOLS: { key: ToolKey; name: string; why: string }[] = [
  { key: "git", name: "Git", why: "sauvegardes du projet, requis par Claude Code" },
  { key: "node", name: "Node.js", why: "nécessaire pour installer Claude Code" },
  { key: "claude", name: "Claude Code", why: "le moteur des agents" },
];

type Phase = "checking" | "installing" | "login" | "failed" | "ready";

/**
 * Shown before the app on a computer that misses Git, Node.js or Claude Code:
 * installs them, then lets the user sign in to Claude.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [prereqs, setPrereqs] = useState<Prereqs | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const startedRef = useRef(false);
  const logRef = useRef<HTMLDivElement>(null);

  async function install() {
    setPhase("installing");
    setError(null);
    const channel = new Channel<SetupProgress>();
    channel.onmessage = (event) => {
      if (event.event === "step") {
        setCurrent(event.data.tool);
      } else if (event.event === "line") {
        setLines((list) => [...list, event.data.text].slice(-200));
      } else {
        setPrereqs((p) => (p ? { ...p, [event.data.tool]: event.data.ok } : p));
      }
    };
    try {
      const after = await invoke<Prereqs>("install_prereqs", { onEvent: channel });
      setPrereqs(after);
      setCurrent(null);
      // Claude Code was just installed: the user still has to sign in once.
      setPhase(after.git && after.node && after.claude ? "login" : "failed");
    } catch (err) {
      setCurrent(null);
      setError(String(err));
      setPhase("failed");
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    invoke<Prereqs>("check_prereqs")
      .then((found) => {
        setPrereqs(found);
        if (found.git && found.node && found.claude) {
          setPhase("ready");
        } else {
          install();
        }
      })
      // The check itself failed: do not block the app on it.
      .catch(() => setPhase("ready"));
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  if (phase === "ready") return <>{children}</>;

  return (
    <div className="flex h-screen flex-col overflow-hidden rounded-lg border border-white/10 bg-[#09090b]">
      <Titlebar title="Vaiana Coding" />
      <div className="flex min-h-0 flex-1 flex-col px-8 py-6">
        <h1 className="text-lg font-semibold">
          {phase === "login" ? "Dernière étape : connecte-toi à Claude" : "Préparation de ton PC"}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          {phase === "checking" && "Vérification de ce qui est déjà installé..."}
          {phase === "installing" &&
            "L'app installe ce qui manque. Accepte les fenêtres d'autorisation Windows quand elles apparaissent."}
          {phase === "login" &&
            "Un terminal va s'ouvrir : suis les instructions pour te connecter avec ton compte Claude, puis ferme-le et reviens ici."}
          {phase === "failed" && "Tout n'a pas pu être installé automatiquement."}
        </p>

        <div className="mt-5 space-y-2">
          {TOOLS.map((tool) => {
            const ok = prereqs?.[tool.key] ?? false;
            const running = current === tool.key;
            return (
              <div
                key={tool.key}
                className="flex items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5"
              >
                <div className="flex h-5 w-5 items-center justify-center">
                  {ok ? (
                    <Check className="h-4 w-4 text-emerald-400" />
                  ) : running || phase === "checking" ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                  ) : phase === "failed" ? (
                    <X className="h-4 w-4 text-red-400" />
                  ) : (
                    <div className="h-2 w-2 rounded-full bg-zinc-600" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{tool.name}</div>
                  <div className="truncate text-[11px] text-zinc-500">{tool.why}</div>
                </div>
                <span className="text-[11px] text-zinc-500">
                  {ok ? "Installé" : running ? "Installation..." : "Manquant"}
                </span>
              </div>
            );
          })}
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-red-500/20 bg-red-500/[0.05] px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}

        <div
          ref={logRef}
          className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-500"
        >
          {lines.length === 0 ? "Journal d'installation" : lines.map((line, i) => <div key={i}>{line}</div>)}
        </div>

        <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
          {phase === "failed" && (
            <button
              onClick={install}
              className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/[0.06]"
            >
              Réessayer
            </button>
          )}
          {phase === "login" && (
            <button
              onClick={() => invoke("claude_login").catch((err) => setError(String(err)))}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/[0.06]"
            >
              <LogIn className="h-4 w-4" />
              Me connecter à Claude
            </button>
          )}
          {(phase === "login" || phase === "failed") && (
            <button
              onClick={() => setPhase("ready")}
              className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-black transition-colors hover:bg-emerald-400"
            >
              {phase === "login" ? "C'est fait, continuer" : "Continuer quand même"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
