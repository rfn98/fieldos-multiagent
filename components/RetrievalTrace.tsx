"use client";

import type { RetrievalInfo } from "@/lib/types";

export interface RetrievalTraceProps {
  retrieval: RetrievalInfo;
  model?: string;
  llmMs?: number;
  totalMs?: number;
}

export function RetrievalTrace({ retrieval, model, llmMs, totalMs }: RetrievalTraceProps) {
  const providerLabel = retrieval.provider === "qdrant" ? "Qdrant" : "Moss";
  const rows: [string, string][] = [
    ["Provider", providerLabel],
    ["Index", retrieval.indexName],
    ["Query", retrieval.query],
    ["Evidence records", String(retrieval.documents)],
    [
      "Retrieval latency",
      retrieval.latencyMs === null ? "—" : `${retrieval.latencyMs} ms`,
    ],
    ["Reasoning model", model ?? "—"],
    ["LLM latency", llmMs === undefined ? "—" : `${llmMs} ms`],
    ["Total", totalMs === undefined ? "—" : `${totalMs} ms`],
  ];

  return (
    <section className="px-6 pb-6">
      <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
        Retrieval trace
      </h2>

      <div className="mt-3 border border-zinc-800 bg-zinc-950 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2">
          <span className="uppercase tracking-widest text-zinc-500">{providerLabel.toUpperCase()} RETRIEVAL</span>
          <span className="text-zinc-400">
            {retrieval.documents} evidence record{retrieval.documents === 1 ? "" : "s"}
          </span>
        </div>

        <dl className="grid grid-cols-[150px_1fr] gap-y-1 px-4 py-3">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="py-0.5 text-zinc-600">{label}</dt>
              <dd className="break-words py-0.5 pl-4 text-zinc-300">{value}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}