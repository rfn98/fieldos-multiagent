import { NextRequest, NextResponse } from "next/server";
import { PipeError, type PipeErrorKind } from "@/lib/types";
import { investigate } from "@/lib/investigate";

export const runtime = "nodejs";

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
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return errorResponse("invalid_request", "Request body must be a JSON object.");
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return errorResponse("invalid_request", "Request body must be valid JSON.");
  }

  try {
    const result = await investigate({
      question: body.question,
      source: body.source,
      transcript: body.transcript,
      timestamp: body.timestamp,
      sessionId: body.sessionId,
      metadata: body.metadata,
    });
    const status = result.workflow?.status === "failed" ? result.workflow.errorStatus ?? 500 : 200;
    return NextResponse.json(result, { status });
  } catch (error) {
    if (error instanceof PipeError) {
      return errorResponse(error.kind, error.message);
    }
    console.error("[api/investigate] unexpected error", error);
    return errorResponse("internal", "Internal server error.");
  }
}