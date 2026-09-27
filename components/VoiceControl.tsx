"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { InvestigateResult, InvestigationPhase } from "@/lib/types";

type VoiceState = "idle" | "listening" | "denied" | "nospeech" | "unsupported";

interface SpeechRecognitionEvent {
  results: {
    length: number;
    [index: number]: {
      isFinal: boolean;
      length: number;
      [index: number]: { transcript: string };
    };
  };
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  continuous: boolean;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

const STATUS_TEXT: Record<VoiceState, string> = {
  idle: "Ask about this asset",
  listening: "Listening…",
  denied: "Microphone access is unavailable.",
  nospeech: "Could not hear speech. Try again.",
  unsupported: "Voice session unavailable. Text investigation is still available.",
};

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  const win = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

export interface VoiceControlProps {
  phase: InvestigationPhase;
  result: InvestigateResult | null;
  onSubmit: (question: string) => void;
}

export function VoiceControl({ phase, result, onSubmit }: VoiceControlProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const recRef = useRef<SpeechRecognitionLike | null>(null);
  const voiceInitiatedRef = useRef(false);
  const settledRef = useRef(false);

  const busy = phase === "loading";

  const cancelSpeech = useCallback(() => {
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }, []);

  useEffect(() => {
    if (phase === "loading" || phase === "idle" || phase === "error") {
      cancelSpeech();
    }
    if (phase === "idle" || phase === "error") {
      voiceInitiatedRef.current = false;
    }
  }, [phase, cancelSpeech]);

  useEffect(() => {
    if (phase !== "success" || !result || !voiceInitiatedRef.current) return;
    voiceInitiatedRef.current = false;
    cancelSpeech();
    if (!("speechSynthesis" in window) || !("SpeechSynthesisUtterance" in window)) return;
    const utterance = new SpeechSynthesisUtterance(result.answer);
    utterance.rate = 1;
    window.speechSynthesis.speak(utterance);
  }, [phase, result, cancelSpeech]);

  useEffect(() => {
    return () => {
      cancelSpeech();
      recRef.current?.abort();
    };
  }, [cancelSpeech]);

  const handleClick = useCallback(() => {
    if (busy) return;
    if (state === "listening") return;
    setState("idle");

    const ctor = getRecognitionCtor();
    if (!ctor) {
      setState("unsupported");
      return;
    }

    const rec = new ctor();
    recRef.current?.abort();
    recRef.current = rec;

    settledRef.current = false;
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.continuous = false;

    rec.onstart = () => {
      if (!settledRef.current) setState("listening");
    };

    rec.onresult = (event) => {
      if (settledRef.current) return;
      settledRef.current = true;
      try {
        rec.stop();
      } catch {
        // recognition may have already stopped
      }
      const first = event.results[0];
      const transcript = first && first.length > 0 ? first[0].transcript.trim() : "";
      if (!transcript) {
        setState("nospeech");
        return;
      }
      voiceInitiatedRef.current = true;
      onSubmit(transcript);
    };

    rec.onerror = (event) => {
      if (settledRef.current) return;
      settledRef.current = true;
      try {
        rec.abort();
      } catch {
        // recognition may have already stopped
      }
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "permission-denied"
      ) {
        setState("denied");
      } else if (event.error === "no-speech" || event.error === "aborted") {
        setState("nospeech");
      } else {
        setState("unsupported");
      }
    };

    rec.onend = () => {
      if (settledRef.current) {
        setState((current) => (current === "listening" ? "idle" : current));
        return;
      }
      settledRef.current = true;
      setState("nospeech");
    };

    try {
      rec.start();
    } catch {
      settledRef.current = true;
      setState("nospeech");
    }
  }, [busy, state, onSubmit]);

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/60 px-6 py-2.5">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy || state === "listening"}
        aria-label="Ask FieldOS by voice using the development/test Web Speech adapter"
        title="Development/test browser Web Speech input. Omi webhook input is handled separately."
        className="group flex items-center gap-2.5 border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:border-zinc-600 hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            state === "listening" ? "animate-pulse bg-amber-400" : "bg-zinc-600 group-hover:bg-zinc-400"
          }`}
        />
        <span>{STATUS_TEXT[state]}</span>
        <span className="border border-zinc-800 px-1 text-[9px] tracking-widest text-zinc-600">DEV/TEST</span>
      </button>
    </div>
  );
}