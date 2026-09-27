"use client";

import type { WorkflowTrace } from "@/lib/types";

export interface InputSourceBadgeProps {
  trace: WorkflowTrace;
}

export function InputSourceBadge({ trace }: InputSourceBadgeProps) {
  const omi = trace.inputChannel === "omi_voice";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span
        className={`border px-2 py-1 font-mono text-[10px] uppercase tracking-widest ${
          omi ? "border-sky-900 bg-sky-950/40 text-sky-300" : "border-zinc-700 bg-zinc-900 text-zinc-400"
        }`}
      >
        {trace.inputLabel}
      </span>
      <span className="font-mono text-[10px] text-zinc-600">
        {omi
          ? "Transcript received from the Omi wearable webhook"
          : "Typed in the browser — not Omi hardware"}
      </span>
    </div>
  );
}
