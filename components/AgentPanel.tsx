"use client";

import type { WorkflowAgentView } from "@/lib/types";

const STATUS_STYLE: Record<WorkflowAgentView["status"], { marker: string; text: string }> = {
  completed: { marker: "✓", text: "text-emerald-400" },
  skipped: { marker: "–", text: "text-zinc-600" },
  failed: { marker: "✕", text: "text-red-400" },
};

export interface AgentPanelProps {
  agents: WorkflowAgentView[];
}

export function AgentPanel({ agents }: AgentPanelProps) {
  return (
    <section className="px-6 pb-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Lyzr agent orchestration
        </h2>
        <span className="text-[11px] font-mono text-zinc-600">Structured roles · validated output</span>
      </div>

      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {agents.map((agent) => {
          const style = STATUS_STYLE[agent.status];
          return (
            <li key={agent.role} className="border border-zinc-800 bg-zinc-950 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className={`font-mono text-xs ${style.text}`}>{style.marker}</span>
                <span className="font-mono text-xs tracking-widest text-zinc-200">{agent.label}</span>
                {agent.mock && (
                  <span className="border border-zinc-800 px-1 font-mono text-[9px] uppercase tracking-widest text-zinc-500">
                    mock
                  </span>
                )}
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{agent.status}</span>
              </div>

              {agent.decision ? (
                <p className="mt-2 break-words font-mono text-[11px] leading-relaxed text-zinc-400">
                  {agent.decision}
                </p>
              ) : (
                <p className="mt-2 font-mono text-[11px] text-zinc-600">No decision recorded.</p>
              )}

              {agent.latencyMs > 0 && (
                <p className="mt-1 font-mono text-[10px] text-zinc-600">{agent.latencyMs}ms</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
