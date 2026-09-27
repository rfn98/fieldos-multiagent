import { NextRequest, NextResponse } from "next/server";
import { PipeError, type PipeErrorKind } from "@/lib/types";
import { normalizeOmiPayload } from "@/lib/omi/adapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ERROR_STATUS: Record<PipeErrorKind, number> = {
  invalid_request: 400,
  database: 500,
  moss_config: 503,
  moss_retrieval: 502,
  qdrant_config: 503,
  qdrant_request: 502,
  lyzr_config: 503,
  lyzr_request: 502,
  lyzr_malformed: 502,
  omi_config: 503,
  omi_request: 400,
  llm_config: 503,
  llm_request: 502,
  llm_malformed: 502,
  internal: 500,
};

function errorResponse(kind: PipeErrorKind, message: string): NextResponse {
  return NextResponse.json({ error: { kind, message } }, { status: ERROR_STATUS[kind] });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse("omi_request", "Omi webhook body must be valid JSON.");
  }

  try {
    const searchParams = request.nextUrl.searchParams;
    const input = normalizeOmiPayload(payload, {
      userId: searchParams.get("uid"),
      sessionId: searchParams.get("session_id"),
    });

    return NextResponse.json({
      accepted: true,
      source: input.source,
      kind: input.metadata.kind,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      segmentCount: input.metadata.segmentCount,
      input: {
        source: input.source,
        transcript: input.transcript,
        timestamp: input.timestamp,
        sessionId: input.sessionId,
        metadata: {
          kind: input.metadata.kind,
          userId: input.metadata.userId,
          segmentCount: input.metadata.segmentCount,
          ...(input.metadata.memoryId ? { memoryId: input.metadata.memoryId } : {}),
          ...(input.metadata.structured ? { structured: input.metadata.structured } : {}),
        },
      },
      handoff: {
        endpoint: "/api/investigate",
        method: "POST",
        note: "POST the `input` object to run the FieldOS multi-agent workflow for this Omi transcript.",
      },
    });
  } catch (error) {
    if (error instanceof PipeError) {
      return errorResponse(error.kind, error.message);
    }
    console.error("[api/omi/webhook] unexpected error", error);
    return errorResponse("internal", "Omi webhook processing failed.");
  }
}
