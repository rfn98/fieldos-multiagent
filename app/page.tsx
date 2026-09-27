"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AssetSummary, InvestigateResult, InvestigationPhase } from "@/lib/types";
import { AssetSidebar } from "@/components/AssetSidebar";
import { AssetHeader } from "@/components/AssetHeader";
import { InvestigationPanel } from "@/components/InvestigationPanel";
import { VoiceControl } from "@/components/VoiceControl";
import { EvidencePanel } from "@/components/EvidencePanel";
import { RetrievalTrace } from "@/components/RetrievalTrace";
import { WorkflowTracePanel } from "@/components/WorkflowTracePanel";
import { AgentPanel } from "@/components/AgentPanel";
import { MemoryPanel } from "@/components/MemoryPanel";
import { ActionPanel } from "@/components/ActionPanel";
import { InputSourceBadge } from "@/components/InputSourceBadge";

type AssetsStatus = "loading" | "loaded" | "error";

const DEMO_REQUEST_ONE = "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.";
const DEMO_REQUEST_TWO = "What's the status of the pump I reported yesterday?";

export default function Home() {
  const [assets, setAssets] = useState<AssetSummary[]>([]);
  const [assetsStatus, setAssetsStatus] = useState<AssetsStatus>("loading");
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [question, setQuestion] = useState<string>("");

  const [phase, setPhase] = useState<InvestigationPhase>("idle");
  const [result, setResult] = useState<InvestigateResult | null>(null);
  const [errorKind, setErrorKind] = useState<string | null>(null);
  const investigationRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;

    async function loadAssets() {
      try {
        const response = await fetch("/api/assets");
        if (!response.ok) throw new Error(`assets status ${response.status}`);
        const data: { assets: AssetSummary[] } = await response.json();
        if (cancelled) return;
        setAssets(data.assets);
        const preferred = data.assets.find((asset) => asset.code === "P-204");
        investigationRequest.current += 1;
        setSelectedCode(preferred?.code ?? data.assets[0]?.code ?? null);
        setAssetsStatus("loaded");
      } catch (error) {
        console.error("[fieldos] failed to load assets", error);
        if (!cancelled) {
          investigationRequest.current += 1;
          setAssetsStatus("error");
          setSelectedCode(null);
        }
      }
    }

    loadAssets();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedAsset = useMemo(
    () => assets.find((asset) => asset.code === selectedCode) ?? null,
    [assets, selectedCode]
  );

  const defaultQuestion = selectedAsset
    ? `Why did ${selectedAsset.code} fail before?`
    : "Why did P-204 fail before?";

  const exampleQuestions = useMemo(
    () => [DEMO_REQUEST_ONE, DEMO_REQUEST_TWO],
    []
  );

  const trace = result?.workflow?.trace ?? null;

  const handleSelectAsset = useCallback((code: string) => {
    investigationRequest.current += 1;
    setSelectedCode(code);
    setResult(null);
    setPhase("idle");
    setErrorKind(null);
  }, []);

  const handleInvestigate = useCallback(async (question: string) => {
    const requestId = investigationRequest.current + 1;
    investigationRequest.current = requestId;
    setQuestion(question);
    setPhase("loading");
    setResult(null);
    setErrorKind(null);

    try {
      const response = await fetch("/api/investigate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = await response.json().catch(() => null);
      if (investigationRequest.current !== requestId) return;
      if (!response.ok) {
        setErrorKind(data?.workflow?.errorKind ?? data?.error?.kind ?? "internal");
        setPhase("error");
        return;
      }
      setResult(data);
      setPhase("success");
    } catch (error) {
      if (investigationRequest.current !== requestId) return;
      console.error("[fieldos] investigation failed", error);
      setErrorKind("network");
      setPhase("error");
    }
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950 text-zinc-200">
      <AssetSidebar
        assets={assets}
        status={assetsStatus}
        selectedCode={selectedCode}
        onSelect={handleSelectAsset}
      />

      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {selectedAsset ? (
          <>
            <AssetHeader asset={selectedAsset} />
            <VoiceControl phase={phase} result={result} onSubmit={handleInvestigate} />
            <InvestigationPanel
              key={selectedAsset.code}
              phase={phase}
              errorKind={errorKind}
              result={result}
              question={question}
              defaultQuestion={defaultQuestion}
              onQuestionChange={setQuestion}
              examples={exampleQuestions}
              onSubmit={handleInvestigate}
            />
            {result && phase === "success" && (
              <>
                {trace && (
                  <>
                    <div className="px-6 pb-4">
                      <InputSourceBadge trace={trace} />
                    </div>
                    <WorkflowTracePanel stages={trace.stages} />
                    <AgentPanel agents={trace.agents} />
                    <MemoryPanel
                      memories={trace.memories}
                      fromMemoryAsset={trace.assetResolution?.fromMemory === true}
                      resolutionBasis={trace.assetResolution?.basis}
                    />
                    <ActionPanel
                      trace={trace}
                      intent={result.workflow?.triage.intent ?? "REQUEST_INFORMATION"}
                      answer={result.answer}
                    />
                  </>
                )}
                <EvidencePanel evidence={result.evidence} />
                <RetrievalTrace
                  retrieval={result.retrieval}
                  model={result.model}
                  llmMs={result.latency?.llmMs}
                  totalMs={result.latency?.totalMs}
                />
              </>
            )}
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            {assetsStatus === "loading" && (
              <p className="text-xs font-mono text-zinc-500">Loading operations data…</p>
            )}
            {assetsStatus === "error" && (
              <>
                <div className="border border-red-900 bg-red-950/40 px-4 py-3 text-center">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-red-400">
                    Asset data unavailable
                  </div>
                  <p className="mt-1 text-sm text-red-200/90">
                    Could not load the asset list from the FieldOS API.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm text-zinc-100 hover:bg-zinc-700"
                >
                  Retry
                </button>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}