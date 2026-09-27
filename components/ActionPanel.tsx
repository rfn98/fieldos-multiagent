"use client";

import type { TriageIntent, WorkflowTrace } from "@/lib/types";

export interface ActionPanelProps {
  trace: WorkflowTrace;
  intent: TriageIntent;
  answer: string;
}

export function ActionPanel({ trace, intent, answer }: ActionPanelProps) {
  const { action, verification, memoryPersistence, assetResolution } = trace;
  const partialSuccess = Boolean(
    action && verification?.success && memoryPersistence?.attempted && !memoryPersistence.persisted
  );

  return (
    <section className="px-6 pb-6">
      <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
        Operational action · PostgreSQL
      </h2>

      <div className="mt-3 grid gap-px border border-zinc-800 bg-zinc-800">
        {action ? (
          <>
            <div className="bg-zinc-950 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-500">
                  database action
                </span>
                <span className="font-mono text-xs tracking-widest text-zinc-100">{action.actionType}</span>
                <span className="font-mono text-[11px] text-zinc-500">
                  {action.entity} {action.code}
                </span>
                {action.priority && (
                  <span className="font-mono text-[11px] text-zinc-500">priority {action.priority}</span>
                )}
                {action.status && (
                  <span className="font-mono text-[11px] text-emerald-400">status {action.status}</span>
                )}
              </div>
              <p className="mt-1.5 font-mono text-[11px] text-zinc-500">
                asset {action.asset} · written to PostgreSQL (operational source of truth)
              </p>
            </div>

            <div className="bg-zinc-950 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                  database verification
                </span>
                <span
                  className={`font-mono text-xs tracking-widest ${
                    verification?.success ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {verification?.success ? "PASSED" : "FAILED"}
                </span>
              </div>
              <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
                {verification?.summary ?? "No verification result was recorded."}
              </p>
            </div>

            <div
              className={`px-4 py-3 ${
                memoryPersistence?.persisted ? "bg-zinc-950" : "bg-amber-950/20"
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-mono text-[10px] uppercase tracking-widest text-fuchsia-500">
                  memory persisted
                </span>
                <span className="font-mono text-xs tracking-widest text-zinc-100">AGENT_RESULT</span>
                {memoryPersistence?.persisted ? (
                  <span className="font-mono text-[11px] text-fuchsia-300">status: persisted</span>
                ) : (
                  <span className="font-mono text-[11px] text-amber-400">status: not persisted</span>
                )}
              </div>
              <p className="mt-1.5 font-mono text-[11px] text-zinc-500">
                {memoryPersistence?.memoryId
                  ? `memory id ${memoryPersistence.memoryId}`
                  : "No agent-result memory id was recorded."}
                {memoryPersistence?.collection ? ` · collection ${memoryPersistence.collection}` : ""}
              </p>
            </div>
          </>
        ) : (
          <div className="bg-zinc-950 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">
                {intent === "CHECK_STATUS" ? "current operational state" : "database action"}
              </span>
              <span className="font-mono text-xs tracking-widest text-zinc-300">
                {intent === "CHECK_STATUS" ? "READ ONLY — NO MUTATION" : "NONE EXECUTED"}
              </span>
            </div>
            <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">{answer}</p>
            <p className="mt-1.5 font-mono text-[11px] text-zinc-500">
              {assetResolution
                ? `Current state read from PostgreSQL for ${assetResolution.assetCode}. `
                : ""}
              No work order was created or modified by this request.
            </p>
          </div>
        )}
      </div>

      {partialSuccess && (
        <div className="mt-3 border border-amber-900 bg-amber-950/30 px-4 py-3">
          <div className="font-mono text-[10px] uppercase tracking-widest text-amber-400">
            Partial success
          </div>
          <p className="mt-1 text-xs text-amber-200/90">
            Work order verified successfully, but agent memory persistence failed. The operational
            database action was not rolled back.
          </p>
          {memoryPersistence?.error && (
            <p className="mt-1 break-words font-mono text-[10px] text-amber-300/70">
              {memoryPersistence.error}
            </p>
          )}
        </div>
      )}

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-zinc-600">
        PostgreSQL = operational source of truth (assets, work orders, incidents, verification).
        Qdrant = historical and semantic memory (evidence, past agent reasoning). Memory writes never
        confirm a database action.
      </p>
    </section>
  );
}
