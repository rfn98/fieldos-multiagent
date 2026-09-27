import { PipeError, type NormalizedInvestigationInput } from "../types";

export interface InvestigateInput {
  question?: unknown;
  source?: unknown;
  transcript?: unknown;
  timestamp?: unknown;
  sessionId?: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTimestamp(value: unknown): string {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new PipeError("invalid_request", 400, "timestamp must be a valid ISO date string.");
  }
  return value;
}

function normalizeSessionId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new PipeError("invalid_request", 400, "sessionId must be a string or null.");
  }
  return value.trim() || null;
}

export function normalizeInvestigateInput(input: InvestigateInput): NormalizedInvestigationInput {
  const source = input.source === undefined || input.source === null ? "web" : input.source;
  if (source !== "omi" && source !== "web") {
    throw new PipeError("invalid_request", 400, "source must be omi or web.");
  }

  const transcriptValue = input.transcript ?? input.question;
  if (typeof transcriptValue !== "string" || transcriptValue.trim().length === 0) {
    throw new PipeError("invalid_request", 400, "transcript must be a non-empty string.");
  }

  const metadata = isRecord(input.metadata) ? input.metadata : {};
  return {
    source,
    transcript: transcriptValue.trim(),
    timestamp: normalizeTimestamp(input.timestamp),
    sessionId: normalizeSessionId(input.sessionId),
    metadata,
  };
}
