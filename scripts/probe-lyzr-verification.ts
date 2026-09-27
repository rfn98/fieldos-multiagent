import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch {}

process.env.LYZR_MAX_RETRIES = "0";

import { getLyzrConfig } from "../lib/lyzr/client";
import { runVerification, type AgentContext } from "../lib/workflow/agents";
import type {
  ActionExecutionResult,
  ActionVerificationFact,
  InvestigationResult,
  TriageResult,
} from "../lib/types";
import { PipeError } from "../lib/types";

const TRANSCRIPT = "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.";
const SESSION_ID = "fieldos-demo";
const ALLOWED_PATH = "/inference/chat/";
const REDACTION_MARKER = "[REDACTED_LYZR_API_KEY]";
const FIXTURE_MARKER = "probe-fixture";
const EXPECTED_KEYS = ["success", "summary", "memoryCandidate"];

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

/**
 * Synthetic execution evidence. Nothing here is read from or written to Prisma,
 * Qdrant, Ollama or any other service; these literals only stand in for the
 * deterministic action result that the orchestrator would normally have
 * persisted and read back before the verification agent is called.
 */
const ACTION: ActionExecutionResult = {
  actionType: "CREATE_WORK_ORDER",
  entity: "work_order",
  id: `${FIXTURE_MARKER}-work-order-0001`,
  code: "WO-2026-0001",
  assetId: "P-204",
  assetCode: "P-204",
  summary: "Created work order WO-2026-0001 for P-204: bearing and alignment inspection.",
  details: {
    priority: "HIGH",
    status: "OPEN",
    technicianId: null,
    scheduledAt: null,
    source: FIXTURE_MARKER,
  },
};

const ACTION_VERIFICATION: ActionVerificationFact = {
  persisted: true,
  matches: true,
  record: {
    id: `${FIXTURE_MARKER}-work-order-0001`,
    code: "WO-2026-0001",
    assetCode: "P-204",
    assetId: "P-204",
    status: "OPEN",
    priority: "HIGH",
    technicianId: null,
    createdAt: "2026-09-27T09:00:00.000Z",
    updatedAt: "2026-09-27T09:00:00.000Z",
    source: FIXTURE_MARKER,
  },
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

function capturedVerificationObject(): Record<string, unknown> | null {
  if (!captured || captured.bodyError !== null) return null;
  try {
    const envelope: unknown = JSON.parse(captured.body);
    if (typeof envelope !== "object" || envelope === null) return null;
    const response = (envelope as { response?: unknown }).response;
    if (typeof response !== "string") return null;
    const inner: unknown = JSON.parse(response);
    if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return null;
    return inner as Record<string, unknown>;
  } catch {
    return null;
  }
}

function classifyFailure(error: PipeError): string {
  if (error.kind === "lyzr_request") return "transport";
  if (error.kind === "lyzr_malformed") return "lyzr_response_shape";
  return "other";
}

function printContractMismatch(): void {
  const inner = capturedVerificationObject();
  if (inner === null) return;

  const keys = Object.keys(inner);
  const extra = keys.filter((key) => !EXPECTED_KEYS.includes(key));
  const successType = typeof inner.success;
  const summaryType = typeof inner.summary;

  console.log("");
  console.log("-- contract diagnosis --");
  console.log("returned keys:", keys.join(", ") || "(none)");
  console.log("success type :", successType);
  console.log("summary type :", summaryType);
  console.log("extra keys   :", extra.join(", ") || "(none)");

  if (extra.length > 0) {
    console.log("");
    console.log(
      `Likely cause: verificationSchema is .strict(), so the top-level key(s) ${extra.join(", ")} are rejected even though they may be null or empty.`
    );
    console.log("Only success, summary and optional memoryCandidate are accepted.");
  }
  if (successType !== "boolean") {
    console.log("");
    console.log(
      `Likely cause: success must be a JSON boolean, but the provider returned ${successType}.`
    );
  }
  if (inner.memoryCandidate !== undefined && inner.memoryCandidate !== null) {
    const candidate = inner.memoryCandidate;
    const candidateKeys =
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
        ? Object.keys(candidate as Record<string, unknown>)
        : [];
    const extraCandidate = candidateKeys.filter((key) => key !== "text" && key !== "sourceId");
    if (extraCandidate.length > 0) {
      console.log("");
      console.log(
        `Likely cause: memoryCandidate is .strict(), so the key(s) ${extraCandidate.join(", ")} are rejected.`
      );
    }
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
  const namespacedSessionId = `${SESSION_ID}::verification`;

  console.log("== Lyzr Verification live smoke test (debug) ==");
  console.log("provider   :", config.provider);
  console.log("base URL   :", config.baseUrl);
  console.log("user_id    :", config.userId);
  console.log("agent_id   :", config.agentIds.verification);
  console.log("session_id :", namespacedSessionId);
  console.log("transcript :", TRANSCRIPT);
  console.log(
    "action ctx :",
    `${ACTION.actionType} / ${ACTION.code} / ${ACTION.assetCode} / ${ACTION.entity}`
  );
  console.log(
    "read-back  :",
    `persisted=${ACTION_VERIFICATION.persisted} matches=${ACTION_VERIFICATION.matches} (${FIXTURE_MARKER})`
  );
  console.log(
    "fixture    :",
    "PROBE FIXTURE DATA - synthetic literals only. Prisma, Qdrant and Ollama are not called."
  );
  console.log("context    : asset=null retrieval=null");

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
    action: ACTION,
    actionVerification: ACTION_VERIFICATION,
  };

  const { value, trace } = await runVerification(context);

  console.log("");
  console.log("-- result --");
  console.log("request       :", "OK");
  console.log("role / status :", `${trace.role} / ${trace.status}`);
  console.log("provider      :", `${trace.provider} (mock=${trace.mock})`);
  console.log("mock          :", trace.mock);
  console.log("JSON parsing  :", "PASS (production parseAgentJson)");
  console.log("Zod parsing   :", "PASS (production verificationSchema)");
  console.log("success       :", value.success);
  console.log("summary       :", value.summary);
  console.log(
    "memoryCandidate:",
    value.memoryCandidate === undefined ? "(absent)" : JSON.stringify(value.memoryCandidate)
  );
  console.log("latency       :", `${trace.latencyMs} ms`);
  console.log("http requests :", requestCount);
  console.log("");
  console.log("verification result:");
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
    } else {
      console.log("classification:", "other");
      console.error("error         :", error);
    }

    printContractMismatch();
    printCapturedResponse();
    printRedactionNotice();

    process.exitCode = 1;
  });
