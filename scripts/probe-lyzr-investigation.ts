import { loadEnvFile } from "node:process";
try {
  loadEnvFile();
} catch {}

process.env.LYZR_MAX_RETRIES = "0";

import { getLyzrConfig } from "../lib/lyzr/client";
import { runInvestigation, type AgentContext } from "../lib/workflow/agents";
import type { QdrantDocument, QdrantRetrieval } from "../lib/qdrant/retrieval";
import type { TriageResult } from "../lib/types";
import { PipeError } from "../lib/types";

const TRANSCRIPT = "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.";
const SESSION_ID = "fieldos-demo";
const ALLOWED_PATH = "/inference/chat/";
const REDACTION_MARKER = "[REDACTED_LYZR_API_KEY]";

const TRIAGE: TriageResult = {
  intent: "REPORT_ISSUE",
  assetId: "P-204",
  plantId: null,
  issue: "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.",
  severity: null,
  requiresInvestigation: true,
};

const FIXTURE_DOCS: QdrantDocument[] = [
  {
    id: "probe-fixture-p204-vibration",
    text: "Prior report: P-204 exhibited rising vibration over three consecutive shifts. Inspection deferred pending parts availability.",
    content: "Prior report: P-204 exhibited rising vibration over three consecutive shifts. Inspection deferred pending parts availability.",
    score: 0.92,
    memoryId: "probe-fixture-p204-vibration",
    type: "incident",
    assetId: "P-204",
    source: "probe-fixture",
    metadata: { fixture: "true", assetCode: "P-204" },
  },
  {
    id: "probe-fixture-bearing-sop",
    text: "SOP-BRG-01: Escalating pump vibration requires a bearing and alignment inspection before continued duty.",
    content: "SOP-BRG-01: Escalating pump vibration requires a bearing and alignment inspection before continued duty.",
    score: 0.88,
    memoryId: "probe-fixture-bearing-sop",
    type: "sop",
    assetId: "P-204",
    source: "probe-fixture",
    metadata: { fixture: "true", sopCode: "SOP-BRG-01" },
  },
];

const RETRIEVAL: QdrantRetrieval = {
  docs: FIXTURE_DOCS,
  latencyMs: 0,
  collectionName: "probe-fixture-not-a-real-collection",
  query: TRANSCRIPT,
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
  const namespacedSessionId = `${SESSION_ID}::investigation`;

  console.log("== Lyzr Investigation live smoke test (debug) ==");
  console.log("provider   :", config.provider);
  console.log("base URL   :", config.baseUrl);
  console.log("user_id    :", config.userId);
  console.log("agent_id   :", config.agentIds.investigation);
  console.log("session_id :", namespacedSessionId);
  console.log("transcript :", TRANSCRIPT);
  console.log("triage ctx :", JSON.stringify(TRIAGE));
  console.log("evidence   :", `${FIXTURE_DOCS.length} inline probe-fixture docs (Qdrant not called)`);

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
    retrieval: RETRIEVAL,
    investigation: null,
    action: null,
    actionVerification: null,
  };

  const { value, trace } = await runInvestigation(context);

  console.log("");
  console.log("-- result --");
  console.log("request       :", "OK");
  console.log("role / status :", `${trace.role} / ${trace.status}`);
  console.log("provider      :", `${trace.provider} (mock=${trace.mock})`);
  console.log("raw JSON      :", "parsed OK");
  console.log("Zod validation:", "PASS");
  console.log("latency       :", `${trace.latencyMs} ms`);
  console.log("http requests :", requestCount);
  console.log("findings      :", value.findings.length);
  console.log("action chosen :", value.recommendedAction);
  console.log("clarification :", value.clarification === undefined ? "(absent)" : JSON.stringify(value.clarification));
  console.log("");
  console.log("investigation result:");
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
    if (error instanceof PipeError) {
      console.log("request       :", "FAILED");
      console.log("error kind    :", error.kind);
      console.log("error status  :", error.status);
      console.log("error message :", error.message);
    } else {
      console.log("request       :", "FAILED");
      console.error("error         :", error);
    }
    console.log("http requests :", requestCount);

    printCapturedResponse();
    printRedactionNotice();

    process.exitCode = 1;
  });
