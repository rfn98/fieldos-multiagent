import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch {}

process.env.LYZR_MAX_RETRIES = "0";

import { getLyzrConfig } from "../lib/lyzr/client";
import { runAction, type AgentContext } from "../lib/workflow/agents";
import type { InvestigationResult, TriageResult } from "../lib/types";
import { PipeError } from "../lib/types";

const TRANSCRIPT = "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.";
const SESSION_ID = "fieldos-demo";
const ALLOWED_PATH = "/inference/chat/";
const REDACTION_MARKER = "[REDACTED_LYZR_API_KEY]";

const CREATE_WORK_ORDER_OPTIONAL_FIELDS = ["code", "technicianId", "status", "scheduledAt", "completedAt"] as const;

const NULLABLE_OPTIONAL_FIELD_RE = /\b(?:code|technicianId|status|scheduledAt)\b/;

const TRIAGE: TriageResult = {
  intent: "REPORT_ISSUE",
  assetId: "P-204",
  plantId: null,
  issue: TRANSCRIPT,
  severity: null,
  requiresInvestigation: true,
};

const INVESTIGATION: InvestigationResult = {
  findings: [
    "Pump P-204 is exhibiting increased vibration that has been reported as being stronger than the previous day.",
    "There is a history of rising vibration for Pump P-204 over three consecutive shifts.",
  ],
  probableIssue: "Escalating pump vibration may indicate issues with bearings or alignment.",
  supportingEvidence: [
    "Prior report indicates that P-204 exhibited rising vibration over three consecutive shifts, with inspection deferred pending parts availability.",
    "SOP-BRG-01 states that escalating pump vibration requires bearing and alignment inspection before continued duty.",
  ],
  recommendedAction: "CREATE_WORK_ORDER",
  rationale: "To address the increased vibration and prevent potential failure, a work order for a bearing and alignment inspection is necessary as per established SOP.",
  existingWorkOrderCodes: [],
};

const originalFetch = globalThis.fetch;
let requestCount = 0;
let redactionFired = false;

interface CapturedResponse {
  status: number;
  statusText: string;
  contentType: string | null;
  body: string;
  bodyError: string | null;
}

let captured: CapturedResponse | null = null;

function redactApiKey(text: string): string {
  const secret = process.env.LYZR_API_KEY?.trim();
  if (!secret || secret.length < 8) return text;
  if (!text.includes(secret)) return text;
  redactionFired = true;
  return text.split(secret).join(REDACTION_MARKER);
}

async function captureResponse(response: Response): Promise<void> {
  const contentType = response.headers.get("content-type");
  try {
    const body = await response.clone().text();
    captured = {
      status: response.status,
      statusText: response.statusText,
      contentType,
      body: redactApiKey(body),
      bodyError: null,
    };
  } catch (error) {
    captured = {
      status: response.status,
      statusText: response.statusText,
      contentType,
      body: "",
      bodyError: error instanceof Error ? error.message : String(error),
    };
  }
}

const guardedFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : String(input);
  requestCount += 1;
  if (requestCount > 1) {
    throw new Error("Aborted: a second HTTP request was attempted by the smoke test.");
  }
  if (!url.includes(ALLOWED_PATH)) {
    throw new Error(`Aborted: unexpected request target ${url}`);
  }
  const response = await originalFetch(input, init);
  await captureResponse(response);
  return response;
};

globalThis.fetch = guardedFetch;

function capturedDecisionType(): string | null {
  if (!captured || captured.bodyError !== null) return null;
  try {
    const envelope: unknown = JSON.parse(captured.body);
    if (typeof envelope !== "object" || envelope === null) return null;
    const response = (envelope as { response?: unknown }).response;
    if (typeof response !== "string") return null;
    const inner: unknown = JSON.parse(response);
    if (typeof inner !== "object" || inner === null) return null;
    const type = (inner as { type?: unknown }).type;
    return typeof type === "string" ? type : null;
  } catch {
    return null;
  }
}

function classifyFailure(error: PipeError): string {
  if (error.kind === "lyzr_request") return "transport";
  if (error.kind === "lyzr_malformed") return "lyzr_response_shape";
  if (error.kind === "invalid_request") {
    if (/Invalid discriminator value/.test(error.message)) return "production_action_decision";
    if (/Invalid action request at/.test(error.message)) return "production_zod";
  }
  return "other";
}

function printOptionalFieldPresence(decision: Record<string, unknown>): void {
  console.log("optional field presence:");
  for (const field of CREATE_WORK_ORDER_OPTIONAL_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(decision, field) && decision[field] !== undefined;
    const state = present ? (decision[field] === null ? "present (null)" : "present") : "absent";
    console.log(`  ${field.padEnd(13)}: ${state}`);
  }
}

function printCapturedResponse(): void {
  console.log("");
  console.log("-- provider response (captured from the single request) --");

  if (!captured) {
    console.log("capture       : unavailable (no response reached the fetch guard)");
    return;
  }

  console.log("http status   :", `${captured.status} ${captured.statusText}`.trim());
  console.log("content-type  :", captured.contentType ?? "(absent)");

  if (captured.bodyError !== null) {
    console.log("body          : (not readable)");
    console.log("body error    :", captured.bodyError);
    return;
  }

  console.log("body bytes    :", new TextEncoder().encode(captured.body).length);
  console.log("raw body      :");
  console.log(captured.body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(captured.body);
  } catch {
    console.log("");
    console.log("body json     : (body is not valid JSON)");
    return;
  }

  console.log("");
  console.log("-- body parsed as JSON --");
  console.log(JSON.stringify(parsed, null, 2));

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;

  const inner = (parsed as { response?: unknown }).response;
  if (typeof inner !== "string") return;

  console.log("");
  console.log("-- body.response parsed as JSON (exact value Zod received) --");
  try {
    console.log(JSON.stringify(JSON.parse(inner), null, 2));
  } catch {
    console.log("(body.response is not valid JSON)");
    console.log("body.response :", inner);
  }
}

function printRedactionNotice(): void {
  if (!redactionFired) return;
  console.log("");
  console.log(`NOTE: ${REDACTION_MARKER} was substituted where the API key appeared.`);
}

async function main(): Promise<void> {
  const config = getLyzrConfig();

  console.log("== Lyzr Action live smoke test (debug) ==");
  console.log("provider   :", config.provider);
  console.log("base URL   :", config.baseUrl);
  console.log("user_id    :", config.userId);
  console.log("agent_id   :", config.agentIds.action);
  console.log("session_id :", `${SESSION_ID}::action`);
  console.log("transcript :", TRANSCRIPT);
  console.log("triage ctx :", `${TRIAGE.intent} / ${TRIAGE.assetId} / requiresInvestigation=${TRIAGE.requiresInvestigation}`);
  console.log(
    "investigation:",
    `${INVESTIGATION.recommendedAction} / ${INVESTIGATION.findings.length} findings / ${INVESTIGATION.supportingEvidence.length} evidence`
  );
  console.log("context    : asset=null retrieval=null action=null actionVerification=null");

  if (config.maxRetries !== 0) {
    throw new Error(`Expected a zero retry budget, found ${config.maxRetries}.`);
  }

  const context: AgentContext = {
    input: {
      source: "web",
      transcript: TRANSCRIPT,
      timestamp: new Date().toISOString(),
      sessionId: SESSION_ID,
      metadata: {},
    },
    asset: null,
    triage: TRIAGE,
    retrieval: null,
    investigation: INVESTIGATION,
    action: null,
    actionVerification: null,
  };

  const { value, trace } = await runAction(context);
  const decision = value as unknown as Record<string, unknown>;

  console.log("");
  console.log("-- result --");
  console.log("request       :", "OK");
  console.log("role / status :", `${trace.role} / ${trace.status}`);
  console.log("provider      :", `${trace.provider} (mock=${trace.mock})`);
  console.log("actionType    :", value.type);
  console.log("JSON parsing  :", "PASS (production parseAgentJson)");
  console.log("Zod parsing   :", "PASS (production Action decision validation)");
  console.log("fields        :", Object.keys(decision).sort().join(", "));
  console.log("latency       :", `${trace.latencyMs} ms`);
  console.log("http requests :", requestCount);

  if (value.type === "CREATE_WORK_ORDER") {
    printOptionalFieldPresence(decision);
  }

  console.log("");
  console.log("action decision:");
  console.log(JSON.stringify(value, null, 2));

  printCapturedResponse();
  printRedactionNotice();
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.log("");
    console.log("-- result --");
    console.log("request       :", "FAILED");
    console.log("http requests :", requestCount);

    if (error instanceof PipeError) {
      console.log("error kind    :", error.kind);
      console.log("error status  :", error.status);
      console.log("error message :", error.message);
      console.log("classification:", classifyFailure(error));

      const returnedType = capturedDecisionType();
      if (returnedType !== null) {
        console.log("returned type :", returnedType);
      }

      if (
        error.kind === "invalid_request" &&
        returnedType === "CREATE_WORK_ORDER" &&
        NULLABLE_OPTIONAL_FIELD_RE.test(error.message)
      ) {
        console.log("");
        console.log(
          "Likely cause: CREATE_WORK_ORDER returned null for an optional field that production Zod currently defines as optional-but-not-nullable."
        );
        console.log("Affected fields: code, technicianId, status, scheduledAt. Only completedAt is nullable today.");
        console.log("No schema was modified. The raw response above is the evidence for the next change.");
      }
    } else {
      console.log("classification:", "other");
      console.error("error         :", error);
    }

    printCapturedResponse();
    printRedactionNotice();

    process.exitCode = 1;
  });
