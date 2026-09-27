"use client";

import type { WorkflowStage, WorkflowStageState } from "@/lib/types";

const STATE_STYLE: Record<WorkflowStageState, { marker: string; text: string; chip: string }> = {
  pending: { marker: "·", text: "text-zinc-600", chip: "border-zinc-800 text-zinc-600" },
  running: { marker: "▌", text: "text-amber-400", chip: "border-amber-800 text-amber-300" },
  completed: { marker: "✓", text: "text-emerald-400", chip: "border-emerald-900 text-emerald-300" },
  skipped: { marker: "–", text: "text-zinc-600", chip: "border-zinc-800 text-zinc-500" },
  failed: { marker: "✕", text: "text-red-400", chip: "border-red-900 text-red-300" },
};

const ACTOR_COLOR: Record<string, string> = {
  omi: "text-sky-400",
  dev: "text-zinc-500",
  lyzr: "text-violet-400",
  qdrant: "text-amber-400",
  postgres: "text-emerald-400",
};

export interface WorkflowTracePanelProps {
  stages: WorkflowStage[];
}

export function WorkflowTracePanel({ stages }: WorkflowTracePanelProps) {
  return (
    <section className="px-6 pb-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Workflow trace
        </h2>
        <span className="text-[11px] font-mono text-zinc-600">
          Actual executed stages — nothing simulated
        </span>
      </div>

      <ol className="mt-3 grid gap-px border border-zinc-800 bg-zinc-800">
        {stages.map((stage, index) => {
          const style = STATE_STYLE[stage.state];
          return (
            <li
              key={stage.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-zinc-950 px-4 py-2.5"
            >
              <span className="w-5 shrink-0 text-right font-mono text-[10px] text-zinc-700">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className={`w-3 shrink-0 text-center font-mono text-xs ${style.text}`}>
                {style.marker}
              </span>
              <span className="font-mono text-xs tracking-widest text-zinc-200">{stage.label}</span>

              <span
                className={`border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-widest ${style.chip}`}
              >
                {stage.state}
              </span>

              {stage.actor && (
                <span
                  className={`font-mono text-[10px] lowercase tracking-wider ${
                    ACTOR_COLOR[stage.actor] ?? "text-zinc-600"
                  }`}
                >
                  {stage.actor}
                </span>
              )}

              {stage.detail && (
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-400">
                  {stage.detail}
                </span>
              )}

              {stage.latencyMs !== null && (
                <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-600">
                  {stage.latencyMs}ms
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
