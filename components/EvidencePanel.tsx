"use client";

import type { Evidence } from "@/lib/types";

const TYPE_STYLE: Record<string, string> = {
  incident: "text-red-400",
  maintenance: "text-amber-400",
  sop: "text-sky-400",
};

export function EvidencePanel({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) {
    return (
      <section className="px-6 pb-6">
        <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Retrieved evidence
        </h2>
        <p className="mt-2 text-xs font-mono text-zinc-600">
          No evidence was retrieved for this answer.
        </p>
      </section>
    );
  }

  return (
    <section className="px-6 pb-6">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
          Retrieved evidence
        </h2>
        <span className="text-[11px] font-mono text-zinc-600">
          Retrieved operational records — not generated facts
        </span>
      </div>

      <ul className="mt-3 grid gap-2">
        {evidence.map((item) => (
          <li key={`${item.id}-${item.type}`} className="border border-zinc-800 bg-zinc-950 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className={`text-[11px] font-mono uppercase ${TYPE_STYLE[item.type] ?? "text-zinc-400"}`}>
                {item.type}
              </span>
              <span className="font-mono text-xs text-zinc-300">{item.id}</span>
              <span className="font-mono text-xs text-zinc-500">asset {item.assetId}</span>
              <span className="ml-auto font-mono text-xs text-zinc-500">
                {item.score == null ? "—" : `${Math.round(item.score * 100)}% relevance`}
              </span>
            </div>

            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-mono text-zinc-500">
              {item.date && <span>date {item.date.replace("T", " ").replace(/\.\d+Z$/, "Z")}</span>}
              {item.severity && <span>severity {item.severity}</span>}
              {item.category && <span>category {item.category}</span>}
              {item.plantId && <span>plant {item.plantId}</span>}
            </div>

            {item.snippet.length > 0 && (
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">
                {item.snippet}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}