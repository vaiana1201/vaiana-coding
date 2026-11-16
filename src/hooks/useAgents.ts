import { useCallback, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";

export type AgentEvent =
  | { event: "session"; data: { sessionId: string } }
  | { event: "text"; data: { text: string } }
  | { event: "tool"; data: { name: string; detail: string } }
  | { event: "done"; data: { sessionId: string | null; isError: boolean } }
  | { event: "error"; data: { message: string } };

export interface AgentMessage {
  role: "user" | "assistant" | "tool" | "error";
  text: string;
}

export interface Agent {
  id: string;
  name: string;
  sessionId: string | null;
  busy: boolean;
  /** True while this agent runs the automatic playtest (Studio is shared). */
  playtesting: boolean;
  messages: AgentMessage[];
}

export const MAX_AGENTS = 6;

let counter = 0;
function newAgent(index: number): Agent {
  counter += 1;
  return {
    id: `agent-${Date.now()}-${counter}`,
    name: `Agent ${index}`,
    sessionId: null,
    busy: false,
    playtesting: false,
    messages: [],
  };
}

/** Readable name for a tool call, e.g. "mcp__roxlit__run_code" -> "Studio: run_code". */
function toolLabel(name: string, detail: string): string {
  let label = name;
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    label = `Studio: ${parts[parts.length - 1]}`;
  }
  return detail ? `${label} — ${detail}` : label;
}

export function useAgents(projectPath: string) {
  const [agents, setAgents] = useState<Agent[]>(() => [newAgent(1)]);
  const [activeId, setActiveId] = useState<string>(() => agents[0].id);
  const nextIndexRef = useRef(2);
  // Latest agents, readable from callbacks without waiting for a render.
  const agentsRef = useRef(agents);
  agentsRef.current = agents;

  const patch = useCallback((id: string, fn: (a: Agent) => Agent) => {
    setAgents((list) => list.map((a) => (a.id === id ? fn(a) : a)));
  }, []);

  const push = useCallback(
    (id: string, message: AgentMessage) => {
      patch(id, (a) => ({ ...a, messages: [...a.messages, message] }));
    },
    [patch],
  );

  const addAgent = useCallback(() => {
    setAgents((list) => {
      if (list.length >= MAX_AGENTS) return list;
      const agent = newAgent(nextIndexRef.current++);
      setActiveId(agent.id);
      return [...list, agent];
    });
  }, []);

  const stop = useCallback(async (id: string) => {
    await invoke("agent_stop", { agentId: id }).catch(() => {});
  }, []);

  const removeAgent = useCallback(
    (id: string) => {
      stop(id);
      setAgents((list) => {
        const rest = list.filter((a) => a.id !== id);
        const next = rest.length > 0 ? rest : [newAgent(nextIndexRef.current++)];
        setActiveId((current) => (current === id ? next[0].id : current));
        return next;
      });
    },
    [stop],
  );

  const send = useCallback(
    async (id: string, prompt: string, options?: { playtest?: boolean }) => {
      const text = prompt.trim();
      if (!text) return;

      const current = agentsRef.current.find((a) => a.id === id);
      if (!current || current.busy) return;
      const sessionId = current.sessionId;
      patch(id, (a) => ({
        ...a,
        busy: true,
        playtesting: options?.playtest ?? false,
        messages: [...a.messages, { role: "user", text }],
      }));

      const channel = new Channel<AgentEvent>();
      channel.onmessage = (event) => {
        switch (event.event) {
          case "session":
            patch(id, (a) => ({ ...a, sessionId: event.data.sessionId }));
            break;
          case "text":
            push(id, { role: "assistant", text: event.data.text });
            break;
          case "tool":
            push(id, {
              role: "tool",
              text: toolLabel(event.data.name, event.data.detail),
            });
            break;
          case "error":
            push(id, { role: "error", text: event.data.message });
            break;
          case "done":
            patch(id, (a) => ({
              ...a,
              busy: false,
              playtesting: false,
              sessionId: event.data.sessionId ?? a.sessionId,
            }));
            break;
        }
      };

      try {
        await invoke("agent_send", {
          agentId: id,
          projectPath,
          prompt: text,
          sessionId,
          onEvent: channel,
        });
      } catch (err) {
        push(id, { role: "error", text: String(err) });
      } finally {
        patch(id, (a) => ({ ...a, busy: false, playtesting: false }));
      }
    },
    [projectPath, patch, push],
  );

  return { agents, activeId, setActiveId, addAgent, removeAgent, send, stop };
}
