"use client";

import { type FormEvent } from "react";
import type { InvestigateResult, InvestigationPhase } from "@/lib/types";

const ERROR_TEXT: Record<string, string> = {
  network: "Could not reach the FieldOS API.",
  invalid_request: "The investigation request was rejected. Enter a non-empty question.",
  moss_config: "Knowledge retrieval is not available right now. Please try again.",
  moss_retrieval: "Moss retrieval failed — the index could not be queried.",
  qdrant_config:
    "Semantic memory unavailable. Qdrant is not configured, so the investigation could not run.",
  qdrant_request:
    "Semantic memory unavailable. Qdrant retrieval failed. No operational database action was performed or rolled back.",
  lyzr_config: "Agent orchestration unavailable. The Lyzr provider is not configured.",
  lyzr_request:
    "Agent orchestration unavailable. The Lyzr provider is unreachable or returned an error.",
  lyzr_malformed:
    "Agent orchestration unavailable. The Lyzr provider returned a malformed response.",
  omi_config: "Omi integration is not configured.",
  omi_request: "The Omi webhook payload was invalid.",
  llm_config: "The reasoning model is not configured. Set the OLLAMA_* environment variables.",
  llm_request: "The reasoning model provider is unreachable or returned an error.",
  llm_malformed: "The reasoning model returned a malformed response.",
  database: "Operational action failed. A database error occurred.",
  internal: "Unexpected server error.",
};

const PIPELINE: { step: string; title: string; label: string }[] = [
  { step: "01", title: "INPUT", label: "Omi voice or dev/test text" },
  { step: "02", title: "LYZR AGENTS", label: "Triage · investigation · action · verification" },
  { step: "03", title: "QDRANT MEMORY", label: "Historical and semantic recall" },
  { step: "04", title: "POSTGRESQL", label: "Operational write and verification" },
];

const LOADING_STAGES: string[] = [
  "INPUT",
  "TRIAGE",
  "MEMORY RETRIEVAL",
  "INVESTIGATION",
  "ACTION",
  "DATABASE VERIFICATION",
  "MEMORY PERSISTENCE",
];

export interface InvestigationPanelProps {
  phase: InvestigationPhase;
  errorKind: string | null;
  result: InvestigateResult | null;
  question: string;
  defaultQuestion: string;
  examples: string[];
  onSubmit: (question: string) => void;
  onQuestionChange: (question: string) => void;
}

export function InvestigationPanel({
  phase,
  errorKind,
  result,
  question,
  examples,
  onSubmit,
  onQuestionChange,
}: InvestigationPanelProps) {
  const loading = phase === "loading";

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = question.trim();
    if (value.length === 0 || loading) return;
    onSubmit(value);
  }

  function runExample(example: string) {
    if (loading) return;
    onQuestionChange(example);
    onSubmit(example);
  }

  return (
    <section className="px-6 py-5">
      <form onSubmit={handleSubmit} className="flex gap-3">
        <input
          type="text"
          value={question}
          onChange={(event) => onQuestionChange(event.target.value)}
          placeholder="Ask an investigation question…"
          disabled={loading}
          className="min-w-0 flex-1 border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={loading || question.trim().length === 0}
          className="shrink-0 border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Investigating…" : "Investigate"}
        </button>
      </form>

      <div className="mt-5">
        {phase === "loading" && (
          <div className="border border-zinc-800 bg-zinc-950 px-4 py-4">
            <div className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
              FieldOS pipeline in progress
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2">
              {LOADING_STAGES.map((stage) => (
                <li key={stage} className="flex items-baseline gap-2 opacity-60">
                  <span className="font-mono text-[10px] text-amber-400">▌</span>
                  <span className="font-mono text-[11px] tracking-widest text-zinc-300">{stage}</span>
                </li>
              ))}
            </ul>
            <p className="mt-3 font-mono text-[10px] text-zinc-600">
              Stage results appear here when the run completes.
            </p>
          </div>
        )}

        {phase === "error" && (
          <div className="border border-red-900 bg-red-950/40 px-4 py-3">
            <div className="text-[11px] font-mono uppercase tracking-wider text-red-400">
              Investigation unavailable
            </div>
            <p className="mt-1 text-sm text-red-200/90">
              {ERROR_TEXT[errorKind ?? "internal"] ?? ERROR_TEXT.internal}
            </p>
          </div>
        )}

        {phase === "success" && result && (
          <div className="border border-zinc-800 bg-zinc-900/40 px-4 py-4">
            <div className="text-[11px] font-mono uppercase tracking-wider text-zinc-500">
              Response · {result.retrieval.documents} evidence records
            </div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-zinc-200">
              {result.answer}
            </p>
          </div>
        )}

        {(phase === "idle" || phase === "error") && (
          <div className="space-y-4">
            <ol className="flex flex-col gap-3 border border-zinc-800 bg-zinc-950 px-5 py-4 sm:flex-row sm:items-center sm:gap-4">
              {PIPELINE.map((s, i) => (
                <li key={s.title} className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-zinc-600">{s.step}</span>
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-semibold tracking-widest text-zinc-200">
                      {s.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-zinc-500">{s.label}</div>
                  </div>
                  {i < PIPELINE.length - 1 && (
                    <span aria-hidden className="hidden text-zinc-700 sm:inline">
                      →
                    </span>
                  )}
                </li>
              ))}
            </ol>

            <div className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[10px] font-mono uppercase tracking-widest text-zinc-600">
                  Demo
                </span>
                <span className="text-[11px] text-zinc-600">
                  Development helpers — these run through the real workflow.
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {examples.map((ex, index) => (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => runExample(ex)}
                    disabled={loading}
                    className="border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-50"
                  >
                    <span className="mr-2 font-mono text-[10px] text-zinc-600">
                      {index === 0 ? "1" : "2"}
                    </span>
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
