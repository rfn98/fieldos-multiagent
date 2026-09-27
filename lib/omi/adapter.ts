import { PipeError } from "../types";
import {
  type NormalizedOmiInput,
  type OmiPayloadKind,
  type OmiTranscriptSegment,
  type OmiWebhookContext,
} from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function optionalString(value: unknown): string | undefined {
  return cleanString(value) ?? undefined;
}

function optionalStringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeSegment(value: unknown): OmiTranscriptSegment | null {
  if (!isRecord(value)) return null;
  const text = cleanString(value.text);
  if (!text) return null;

  const segment: OmiTranscriptSegment = { text };
  const speaker = optionalString(value.speaker);
  const speakerId = optionalStringOrNumber(value.speakerId);
  const speakerName = optionalString(value.speaker_name);
  const isUser = typeof value.is_user === "boolean" ? value.is_user : undefined;
  const start = optionalNumber(value.start);
  const end = optionalNumber(value.end);

  if (speaker) segment.speaker = speaker;
  if (speakerId !== undefined) segment.speakerId = speakerId;
  if (speakerName) segment.speaker_name = speakerName;
  if (isUser !== undefined) segment.is_user = isUser;
  if (start !== undefined) segment.start = start;
  if (end !== undefined) segment.end = end;

  return segment;
}

function normalizeSegments(value: unknown): OmiTranscriptSegment[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((segment) => normalizeSegment(segment))
    .filter((segment): segment is OmiTranscriptSegment => segment !== null);
}

function payloadKind(payload: unknown): OmiPayloadKind {
  if (Array.isArray(payload)) return "realtime_transcript";
  if (isRecord(payload) && Array.isArray(payload.transcript_segments)) return "memory";
  throw new PipeError("omi_request", 400, "Omi payload must be a transcript segment array or memory object.");
}

function normalizeTimestamp(value: unknown, fallback: Date): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  return fallback.toISOString();
}

function queryValue(contextValue: string | null | undefined, payloadValue: unknown): string | null {
  return cleanString(contextValue) ?? cleanString(payloadValue);
}

export function normalizeOmiPayload(
  payload: unknown,
  context: OmiWebhookContext = {},
  receivedAt = new Date()
): NormalizedOmiInput {
  const kind = payloadKind(payload);
  const record = isRecord(payload) ? payload : null;
  const rawSegments = Array.isArray(payload) ? payload : record?.transcript_segments;
  const segments = normalizeSegments(rawSegments);

  if (segments.length === 0) {
    throw new PipeError("omi_request", 400, "Omi payload did not contain any transcript text.");
  }

  const transcript = segments.map((segment) => segment.text).join(" ").trim();
  if (!transcript) {
    throw new PipeError("omi_request", 400, "Omi transcript was empty.");
  }

  const timestampValue = record?.finished_at ?? record?.created_at;
  const userId = queryValue(context.userId, record?.uid);
  const sessionId = queryValue(context.sessionId, record?.session_id);
  const memoryId = optionalString(record?.id);
  const structured = isRecord(record?.structured) ? record.structured : undefined;

  return {
    source: "omi",
    transcript,
    timestamp: normalizeTimestamp(timestampValue, receivedAt),
    sessionId,
    metadata: {
      kind,
      userId,
      segmentCount: segments.length,
      segments,
      ...(memoryId ? { memoryId } : {}),
      ...(structured ? { structured } : {}),
    },
  };
}

export const normalizeOmiInput = normalizeOmiPayload;
