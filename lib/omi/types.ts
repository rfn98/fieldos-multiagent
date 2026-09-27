export type OmiPayloadKind = "realtime_transcript" | "memory";

export interface OmiTranscriptSegment {
  text: string;
  speaker?: string;
  speakerId?: number | string;
  speaker_name?: string;
  is_user?: boolean;
  start?: number;
  end?: number;
}

export interface NormalizedOmiInput {
  source: "omi";
  transcript: string;
  timestamp: string;
  sessionId: string | null;
  metadata: {
    kind: OmiPayloadKind;
    userId: string | null;
    segmentCount: number;
    segments: OmiTranscriptSegment[];
    memoryId?: string;
    structured?: Record<string, unknown>;
  };
}

export interface OmiWebhookContext {
  userId?: string | null;
  sessionId?: string | null;
}
