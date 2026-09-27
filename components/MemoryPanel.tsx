"use client";

import type { MemoryResolutionBasis, WorkflowMemoryView } from "@/lib/types";

const BASIS_LABEL: Record<MemoryResolutionBasis, string> = {
  agent_result_memory: "a high-confidence agent-result memory (a completed field report)",
  semantic_memory: "semantic memory similarity",
};

const TYPE_STYLE: Record<string, string> = {
  INCIDENT: "text-red-400",
  MAINTENANCE: "text-amber-400",
  WORK_ORDER: "text-emerald-400",
  SOP: "text-sky-400",
  ASSET_CONTEXT: "text-violet-400",
  AGENT_RESULT: "text-fuchsia-400",
  incident: "text-red-400",
  maintenance: "text-amber-400",
  work_order: "text-emerald-400",
  sop: "text-sky-400",
  asset_context: "text-violet-400",
  agent_result: "text-fuchsia-400",
};

export interface MemoryPanelProps {
  memories: WorkflowMemoryView[];
  fromMemoryAsset: boolean;
  resolutionBasis?: MemoryResolutionBasis;
}

export function MemoryPanel({ memories, fromMemoryAsset, resolutionBasis }: MemoryPanelProps) {
  return (
    <section className="px-6 pb-6">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Memory retrieved · Qdrant
        </h2>
        <span className="text-[11px] font-mono text-zinc-600">
          Persistent semantic memory — read only, not the transactional database
        </span>
      </div>

      {fromMemoryAsset && (
        <div className="mt-3 border border-amber-900 bg-amber-950/30 px-4 py-2.5">
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">
            Asset resolution from memory
          </div>
          <p className="mt-1 text-xs text-amber-200/80">
            No asset was named in the request. The target asset was resolved from persistent Qdrant memory,
            then confirmed against PostgreSQL.
          </p>
          <p className="mt-1 font-mono text-[10px] text-amber-300/80">
            basis: {resolutionBasis ? BASIS_LABEL[resolutionBasis] : "semantic memory similarity"}
          </p>
        </div>
      )}

      {memories.length === 0 ? (
        <p className="mt-3 border border-zinc-800 bg-zinc-950 px-4 py-3 font-mono text-xs text-zinc-600">
          No persistent memory was retrieved for this request.
        </p>
      ) : (
        <ul className="mt-3 grid gap-2">
          {memories.map((memory) => (
            <li key={memory.memoryId} className="border border-zinc-800 bg-zinc-950 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  className={`text-[11px] font-mono uppercase ${
                    TYPE_STYLE[memory.type] ?? "text-zinc-400"
                  }`}
                >
                  {memory.type}
                </span>
                <span className="font-mono text-[11px] text-zinc-500">
                  asset {memory.asset} · plant {memory.plant}
                </span>
                <span className="ml-auto font-mono text-[11px] text-zinc-400">
                  score {memory.score.toFixed(2)}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[10px] text-zinc-600">
                <span>id {memory.memoryId}</span>
                {memory.source && <span>source: {memory.source}</span>}
              </div>

              <p className="mt-2 text-xs leading-relaxed text-zinc-400">{memory.preview}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
