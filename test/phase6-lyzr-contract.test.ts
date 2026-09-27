import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { chatWithLyzr, getLyzrConfig, type LyzrChatInput, type LyzrFetch } from "../lib/lyzr/client";
import { parseActionDecision, parseAgentJson, runAction } from "../lib/workflow/agents";
import {
  parseInvestigationResult,
  parseTriageResult,
} from "../lib/workflow/schemas";
import { parseActionRequest } from "../lib/actions/validation";
import { requestedActionFromTranscript, runInvestigationWorkflow } from "../lib/workflow/orchestrator";
import type { QdrantDocument } from "../lib/qdrant/retrieval";
import type { MemoryPersistenceStatus, NormalizedInvestigationInput } from "../lib/types";
import { PipeError } from "../lib/types";

const SECRET = "sk-test-do-not-leak-0123456789";
const AGENT_IDS = {
  triage: "agent-triage-test",
  investigation: "agent-investigation-test",
  action: "agent-action-test",
  verification: "agent-verification-test",
} as const;

const ENV_KEYS = [
  "LYZR_PROVIDER",
  "LYZR_API_BASE_URL",
  "LYZR_API_KEY",
  "LYZR_USER_ID",
  "LYZR_SESSION_ID",
  "LYZR_TRIAGE_AGENT_ID",
  "LYZR_INVESTIGATION_AGENT_ID",
  "LYZR_ACTION_AGENT_ID",
  "LYZR_VERIFICATION_AGENT_ID",
  "LYZR_TIMEOUT_MS",
  "LYZR_MAX_RETRIES",
] as const;

function snapshotEnv(): Array<{ key: string; value: string | undefined }> {
  return ENV_KEYS.map((key) => ({ key, value: process.env[key] }));
}

function restoreEnv(snapshot: Array<{ key: string; value: string | undefined }>): void {
  for (const { key, value } of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function applyLiveEnv(overrides: Record<string, string | undefined> = {}): void {
  process.env.LYZR_PROVIDER = "lyzr";
  process.env.LYZR_API_BASE_URL = "https://agent-prod.studio.lyzr.ai/v3";
  process.env.LYZR_API_KEY = SECRET;
  process.env.LYZR_USER_ID = "fieldos-test-user";
  process.env.LYZR_SESSION_ID = "fieldos-test-session";
  process.env.LYZR_TRIAGE_AGENT_ID = AGENT_IDS.triage;
  process.env.LYZR_INVESTIGATION_AGENT_ID = AGENT_IDS.investigation;
  process.env.LYZR_ACTION_AGENT_ID = AGENT_IDS.action;
  process.env.LYZR_VERIFICATION_AGENT_ID = AGENT_IDS.verification;
  delete process.env.LYZR_TIMEOUT_MS;
  delete process.env.LYZR_MAX_RETRIES;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withLiveEnv<T>(
  fn: () => Promise<T>,
  overrides: Record<string, string | undefined> = {}
): Promise<T> {
  const snapshot = snapshotEnv();
  applyLiveEnv(overrides);
  try {
    return await fn();
  } finally {
    restoreEnv(snapshot);
  }
}

async function withMockEnv<T>(fn: () => Promise<T>): Promise<T> {
  const snapshot = snapshotEnv();
  process.env.LYZR_PROVIDER = "mock";
  for (const key of ENV_KEYS) {
    if (key !== "LYZR_PROVIDER") delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    restoreEnv(snapshot);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ detail: "error" }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

interface CallLog {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: LyzrFetch;
}

function callLog(handler: (index: number) => Promise<Response>): CallLog {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      const index = calls.length;
      calls.push({ url, init });
      return handler(index);
    },
  };
}

function immediateSleep(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

const TRIAGE_INPUT: LyzrChatInput = {
  role: "triage",
  message: "You are the FieldOS triage agent.",
};

const VALID_TRIAGE = { intent: "CHECK_STATUS", assetId: "P-204", requiresInvestigation: false };

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

async function expectPipeError(
  fn: () => Promise<unknown>,
  kind: string,
  status: number
): Promise<PipeError> {
  const caught = await fn().then(
    () => null,
    (error: unknown) => error
  );
  assert.ok(caught instanceof PipeError, `expected a PipeError, received ${String(caught)}`);
  assert.equal(caught.kind, kind);
  assert.equal(caught.status, status);
  return caught;
}

function rejectsWith(kind: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PipeError && error.kind === kind;
}

function rejectsWithAnyPipeError(): (error: unknown) => boolean {
  return (error: unknown) => error instanceof PipeError;
}

test("1. live provider returns the parsed response with live provider metadata", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => jsonResponse({ response: JSON.stringify(VALID_TRIAGE) }));

    const result = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl });

    assert.equal(result.provider, "lyzr");
    assert.equal(result.mock, false);
    assert.equal(result.agentId, AGENT_IDS.triage);
    assert.equal(result.sessionId, "fieldos-test-session::triage");
    assert.equal(result.content, JSON.stringify(VALID_TRIAGE));
    assert.equal(log.calls.length, 1);
  });
});

test("1b. live request uses the documented endpoint, headers and body fields only", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => jsonResponse({ response: JSON.stringify(VALID_TRIAGE) }));

    await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl });

    assert.equal(log.calls.length, 1);
    const call = log.calls[0];
    assert.equal(call.url, "https://agent-prod.studio.lyzr.ai/v3/inference/chat/");
    assert.equal(call.init.method, "POST");

    const headers = (call.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
    assert.equal(headers["x-api-key"], SECRET);
    assert.equal(
      Object.keys(headers).some((key) => key.toLowerCase() === "authorization"),
      false,
      "the documented auth header is x-api-key, not Authorization"
    );
    assert.equal(call.init.signal instanceof AbortSignal, true, "a deadline signal is always supplied");

    const body = bodyOf(call.init);
    assert.deepEqual(Object.keys(body).sort(), ["agent_id", "message", "session_id", "user_id"]);
    assert.equal(body.user_id, "fieldos-test-user");
    assert.equal(body.agent_id, AGENT_IDS.triage);
    assert.equal(body.session_id, "fieldos-test-session::triage");
    assert.equal(body.message, TRIAGE_INPUT.message);
  });
});

test("2. prose instead of JSON fails closed", () => {
  assert.throws(() => parseAgentJson("I think this is a pump problem."), rejectsWith("lyzr_malformed"));
});

test("3. an invalid enum value fails closed in the strict triage schema", () => {
  assert.throws(() => parseTriageResult({ intent: "NONSENSE" }), rejectsWith("lyzr_malformed"));
});

test("4. an extra key is rejected by the strict triage schema", () => {
  assert.throws(
    () => parseTriageResult({ ...VALID_TRIAGE, confidence: 0.9 }),
    rejectsWith("lyzr_malformed")
  );
});

test("5. an empty findings array fails closed in the investigation schema", () => {
  assert.throws(
    () =>
      parseInvestigationResult({
        findings: [],
        recommendedAction: "NO_ACTION",
        rationale: "No evidence.",
      }),
    rejectsWith("lyzr_malformed")
  );
  const grounded = parseInvestigationResult({
    findings: ["Abnormal vibration reported."],
    recommendedAction: "NO_ACTION",
    rationale: "No evidence.",
  });
  assert.equal(grounded.findings.length, 1);
});

test("6. a request that exceeds the deadline fails closed as a timeout", async () => {
  await withLiveEnv(
    async () => {
      const fetchImpl: LyzrFetch = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        });

      const error = await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: immediateSleep().sleep }),
        "lyzr_request",
        502
      );
      assert.match(error.message, /timed out/);
    },
    { LYZR_TIMEOUT_MS: "40", LYZR_MAX_RETRIES: "0" }
  );
});

test("6b. a timeout is retried at most once regardless of the retry budget", async () => {
  await withLiveEnv(
    async () => {
      let attempts = 0;
      const fetchImpl: LyzrFetch = (_url, init) => {
        attempts += 1;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "TimeoutError";
            reject(error);
          });
        });
      };

      await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: immediateSleep().sleep }),
        "lyzr_request",
        502
      );

      assert.equal(attempts, 2);
    },
    { LYZR_TIMEOUT_MS: "40", LYZR_MAX_RETRIES: "5" }
  );
});

test("7. HTTP 500 is retried up to the configured budget then fails closed", async () => {
  await withLiveEnv(
    async () => {
      const log = callLog(async () => errorResponse(500));
      const sleeper = immediateSleep();

      const error = await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
        "lyzr_request",
        502
      );

      assert.match(error.message, /status 500/);
      assert.equal(log.calls.length, 3, "one initial attempt plus two retries");
      assert.equal(sleeper.delays.length, 2);
    },
    { LYZR_MAX_RETRIES: "2" }
  );
});

test("7b. a zero retry budget performs exactly one attempt", async () => {
  await withLiveEnv(
    async () => {
      const log = callLog(async () => errorResponse(503));
      const sleeper = immediateSleep();

      await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
        "lyzr_request",
        502
      );

      assert.equal(log.calls.length, 1);
      assert.equal(sleeper.delays.length, 0);
    },
    { LYZR_MAX_RETRIES: "0" }
  );
});

test("8. HTTP 429 honors Retry-After before retrying and can then succeed", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async (index) =>
      index === 0
        ? errorResponse(429, { "Retry-After": "2" })
        : jsonResponse({ response: JSON.stringify(VALID_TRIAGE) })
    );
    const sleeper = immediateSleep();

    const result = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep });

    assert.equal(result.provider, "lyzr");
    assert.equal(log.calls.length, 2);
    assert.deepEqual(sleeper.delays, [2000], "Retry-After seconds are honoured verbatim");
  });
});

test("8b. HTTP 429 without Retry-After falls back to bounded jittered backoff", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async (index) =>
      index === 0 ? errorResponse(429) : jsonResponse({ response: JSON.stringify(VALID_TRIAGE) })
    );
    const sleeper = immediateSleep();

    await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep });

    assert.equal(log.calls.length, 2);
    assert.equal(sleeper.delays.length, 1);
    assert.equal(sleeper.delays[0] >= 250, true);
    assert.equal(sleeper.delays[0] <= 400, true);
  });
});

test("8c. an absurd Retry-After value is capped so a request cannot hang", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async (index) =>
      index === 0
        ? errorResponse(429, { "Retry-After": "3600" })
        : jsonResponse({ response: JSON.stringify(VALID_TRIAGE) })
    );
    const sleeper = immediateSleep();

    await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep });

    assert.deepEqual(sleeper.delays, [5000]);
  });
});

test("9. HTTP 403 fails closed without any retry", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => errorResponse(403));
    const sleeper = immediateSleep();

    const error = await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
      "lyzr_config",
      503
    );

    assert.match(error.message, /rejected the configured API key/);
    assert.equal(log.calls.length, 1);
    assert.equal(sleeper.delays.length, 0);
  });
});

test("10. HTTP 404 fails closed without any retry", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => errorResponse(404));
    const sleeper = immediateSleep();

    const error = await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
      "lyzr_config",
      503
    );

    assert.match(error.message, /could not be found/);
    assert.equal(log.calls.length, 1);
    assert.equal(sleeper.delays.length, 0);
  });
});

test("10b. a normal 4xx such as 422 is never retried", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => errorResponse(422));
    const sleeper = immediateSleep();

    await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
      "lyzr_request",
      502
    );

    assert.equal(log.calls.length, 1);
    assert.equal(sleeper.delays.length, 0);
  });
});

test("10c. an unparsable success body fails closed as malformed without retry", async () => {
  await withLiveEnv(async () => {
    const log = callLog(
      async () => new Response("not json at all", { status: 200, headers: { "Content-Type": "text/plain" } })
    );
    const sleeper = immediateSleep();

    await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: log.fetchImpl, sleep: sleeper.sleep }),
      "lyzr_malformed",
      502
    );

    assert.equal(log.calls.length, 1);
  });
});

test("10d. a success body with an empty response string fails closed", async () => {
  await withLiveEnv(async () => {
    const fetchImpl: LyzrFetch = async () => jsonResponse({ response: "   " });

    await expectPipeError(() => chatWithLyzr(TRIAGE_INPUT, { fetchImpl }), "lyzr_malformed", 502);
  });
});

test("11. a network failure is retried and then fails closed", async () => {
  await withLiveEnv(
    async () => {
      let attempts = 0;
      const fetchImpl: LyzrFetch = async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      };
      const sleeper = immediateSleep();

      await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: sleeper.sleep }),
        "lyzr_request",
        502
      );

      assert.equal(attempts, 3);
      assert.equal(sleeper.delays.length, 2);
    },
    { LYZR_MAX_RETRIES: "2" }
  );
});

test("11b. a network failure that recovers on retry returns the successful result", async () => {
  await withLiveEnv(async () => {
    let attempts = 0;
    const fetchImpl: LyzrFetch = async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("fetch failed");
      return jsonResponse({ response: JSON.stringify(VALID_TRIAGE) });
    };

    const result = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: immediateSleep().sleep });

    assert.equal(attempts, 2);
    assert.equal(result.provider, "lyzr");
    assert.equal(result.mock, false);
  });
});

test("12. no thrown error or outbound url/body leaks the API key", async () => {
  await withLiveEnv(
    async () => {
      const urls: string[] = [];
      const bodies: string[] = [];
      const headerSets: string[] = [];
      const fetchImpl: LyzrFetch = async (url, init) => {
        urls.push(url);
        bodies.push(String(init.body ?? ""));
        headerSets.push(JSON.stringify(init.headers ?? {}));
        return errorResponse(500);
      };

      const error = await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: immediateSleep().sleep }),
        "lyzr_request",
        502
      );

      assert.equal(
        headerSets.every((value) => value.includes(SECRET)),
        true,
        "the key belongs in the x-api-key header"
      );

      const errors = [error.message, error.kind, String(error.status)];
      for (const value of [...urls, ...bodies, ...errors]) {
        assert.equal(value.includes(SECRET), false, `the API key leaked via: ${value}`);
      }
    },
    { LYZR_MAX_RETRIES: "0" }
  );
});

test("12b. a placeholder key is replaced by a config error that does not echo the real key", async () => {
  await withLiveEnv(async () => {
    process.env.LYZR_API_KEY = "your-api-key";

    const error = await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: async () => jsonResponse({ response: "{}" }) }),
      "lyzr_config",
      503
    );

    assert.equal(error.message.includes(SECRET), false);
    assert.equal(error.message.includes("your-api-key"), false, "placeholders are not echoed either");
  });
});

test("13. the live provider never degrades to a mock result on failure", async () => {
  await withLiveEnv(async () => {
    const fetchImpl: LyzrFetch = async () => errorResponse(500);

    const error = await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl, sleep: immediateSleep().sleep }),
      "lyzr_request",
      502
    );
    assert.notEqual(error.kind, "mock");

    const recovered = await chatWithLyzr(TRIAGE_INPUT, {
      fetchImpl: async () => jsonResponse({ response: JSON.stringify(VALID_TRIAGE) }),
    });
    assert.equal(recovered.mock, false);
    assert.equal(recovered.provider, "lyzr");
  });
});

test("14. mock provider behaviour is unchanged and performs no network call", async () => {
  await withMockEnv(async () => {
    let networkCalls = 0;
    const fetchImpl: LyzrFetch = async () => {
      networkCalls += 1;
      return jsonResponse({ response: "{}" });
    };

    const triage = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl });
    assert.equal(triage.provider, "mock");
    assert.equal(triage.mock, true);
    assert.equal(triage.content, "[MOCK LYZR] triage agent received: You are the FieldOS triage agent.");
    assert.equal(triage.sessionId, "mock-session");
    assert.equal(triage.agentId, "mock-triage");
    assert.equal(triage.latencyMs, 0);

    const investigation = await chatWithLyzr({ role: "investigation", message: "investigate" }, { fetchImpl });
    assert.equal(investigation.agentId, "mock-investigation");
    assert.equal(investigation.content, "[MOCK LYZR] investigation agent received: investigate");

    const verification = await chatWithLyzr(
      { role: "verification", message: "verify", sessionId: "app-session-9" },
      { fetchImpl }
    );
    assert.equal(verification.agentId, "mock-verification");
    assert.equal(verification.sessionId, "app-session-9", "mock session ids are not namespaced");

    assert.equal(networkCalls, 0, "the mock path must not perform any HTTP call");
  });
});

test("15. missing and placeholder API keys are rejected before any request", async () => {
  await withLiveEnv(async () => {
    let networkCalls = 0;
    const fetchImpl: LyzrFetch = async () => {
      networkCalls += 1;
      return jsonResponse({ response: "{}" });
    };

    for (const placeholder of ["", "   ", "your-api-key", "<api-key>", "xxx", "undefined", "..."]) {
      process.env.LYZR_API_KEY = placeholder;
      const error = await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl }),
        "lyzr_config",
        503
      );
      assert.match(error.message, /LYZR_API_KEY/);
    }

    assert.equal(networkCalls, 0);
  });
});

test("15b. a placeholder agent id is treated as unconfigured", async () => {
  await withLiveEnv(
    async () => {
      process.env.LYZR_TRIAGE_AGENT_ID = "your-agent-id";
      const fetchImpl: LyzrFetch = async () => jsonResponse({ response: "{}" });

      const error = await expectPipeError(
        () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl }),
        "lyzr_config",
        503
      );
      assert.match(error.message, /agent for role triage is not configured/);
    },
    { LYZR_MAX_RETRIES: "0" }
  );
});

test("15c. missing identity and an unknown provider value are rejected", async () => {
  await withLiveEnv(async () => {
    delete process.env.LYZR_USER_ID;
    await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: async () => jsonResponse({ response: "{}" }) }),
      "lyzr_config",
      503
    );

    process.env.LYZR_USER_ID = "fieldos-test-user";
    delete process.env.LYZR_SESSION_ID;
    await expectPipeError(
      () => chatWithLyzr(TRIAGE_INPUT, { fetchImpl: async () => jsonResponse({ response: "{}" }) }),
      "lyzr_config",
      503
    );

    process.env.LYZR_PROVIDER = "live";
    assert.throws(() => getLyzrConfig(), rejectsWith("lyzr_config"));
  });
});

test("16. each role receives its own namespaced session id", async () => {
  await withLiveEnv(async () => {
    const sessions: string[] = [];
    const fetchImpl: LyzrFetch = async (_url, init) => {
      const body = bodyOf(init);
      sessions.push(String(body.session_id));
      return jsonResponse({ response: JSON.stringify(VALID_TRIAGE) });
    };

    for (const role of ["triage", "investigation", "action", "verification"] as const) {
      await chatWithLyzr({ role, message: `hello ${role}` }, { fetchImpl });
    }

    assert.deepEqual(sessions, [
      "fieldos-test-session::triage",
      "fieldos-test-session::investigation",
      "fieldos-test-session::action",
      "fieldos-test-session::verification",
    ]);
    assert.equal(new Set(sessions).size, 4);
  });
});

test("16b. a per-request session id overrides the configured one and is still namespaced", async () => {
  await withLiveEnv(async () => {
    const fetchImpl: LyzrFetch = async (_url, init) => {
      assert.equal(bodyOf(init).session_id, "worker-7::verification");
      return jsonResponse({ response: JSON.stringify(VALID_TRIAGE) });
    };

    const result = await chatWithLyzr(
      { role: "verification", message: "verify", sessionId: "worker-7" },
      { fetchImpl }
    );
    assert.equal(result.sessionId, "worker-7::verification");
  });
});

test("16c. a per-request user id overrides the configured one", async () => {
  await withLiveEnv(async () => {
    const fetchImpl: LyzrFetch = async (_url, init) => {
      assert.equal(bodyOf(init).user_id, "operator-42");
      return jsonResponse({ response: JSON.stringify(VALID_TRIAGE) });
    };

    await chatWithLyzr({ ...TRIAGE_INPUT, userId: "operator-42" }, { fetchImpl });
  });
});

const ASSET_UUID = "a0000000-0000-4000-8000-0000000002a4";

const ACTION_VARIANTS: Array<{ label: string; payload: Record<string, unknown>; expectedType: string }> = [
  {
    label: "CREATE_WORK_ORDER",
    payload: {
      type: "CREATE_WORK_ORDER",
      assetId: ASSET_UUID,
      title: "Inspect intake filter",
      description: "Vibration follow-up inspection.",
      reason: "Reported abnormal vibration.",
      priority: "HIGH",
    },
    expectedType: "CREATE_WORK_ORDER",
  },
  {
    label: "UPDATE_WORK_ORDER",
    payload: {
      type: "UPDATE_WORK_ORDER",
      reason: "Escalating the priority.",
      workOrderCode: "WO-2026-004",
      priority: "CRITICAL",
    },
    expectedType: "UPDATE_WORK_ORDER",
  },
  {
    label: "CREATE_INCIDENT",
    payload: {
      type: "CREATE_INCIDENT",
      assetId: ASSET_UUID,
      title: "Unexpected pump shutdown",
      description: "The pump stopped unexpectedly.",
      rootCause: "Intake filter blockage.",
      reason: "Field report.",
      severity: "CRITICAL",
    },
    expectedType: "CREATE_INCIDENT",
  },
  {
    label: "RECORD_OBSERVATION",
    payload: {
      type: "RECORD_OBSERVATION",
      assetId: ASSET_UUID,
      title: "Operator observation",
      description: "Noted abnormal noise during walkaround.",
      reason: "Routine walkaround.",
    },
    expectedType: "RECORD_OBSERVATION",
  },
  {
    label: "ESCALATE_INCIDENT",
    payload: {
      type: "ESCALATE_INCIDENT",
      reason: "Severity increased after inspection.",
      incidentCode: "INC-2026-002",
      severity: "CRITICAL",
    },
    expectedType: "ESCALATE_INCIDENT",
  },
  {
    label: "NO_ACTION",
    payload: { type: "NO_ACTION", reason: "The evidence does not ground a mutation." },
    expectedType: "NO_ACTION",
  },
  {
    label: "NEEDS_CLARIFICATION",
    payload: {
      type: "NEEDS_CLARIFICATION",
      reason: "The referenced asset is ambiguous.",
      clarification: "Which pump do you mean?",
    },
    expectedType: "NEEDS_CLARIFICATION",
  },
];

test("17. all seven action union variants parse through the existing boundary", () => {
  for (const variant of ACTION_VARIANTS) {
    const parsed = parseActionDecision(variant.payload);
    assert.equal(parsed.type, variant.expectedType, variant.label);
  }
  assert.equal(ACTION_VARIANTS.length, 7);
});

test("17b. an UPDATE_WORK_ORDER without any identifier fails closed", () => {
  assert.throws(
    () => parseActionDecision({ type: "UPDATE_WORK_ORDER", reason: "No identifier.", priority: "HIGH" }),
    rejectsWithAnyPipeError()
  );
  assert.throws(
    () => parseActionRequest({ type: "UPDATE_WORK_ORDER", reason: "No identifier.", priority: "HIGH" }),
    rejectsWithAnyPipeError()
  );
});

test("17c. an UPDATE_WORK_ORDER with an identifier but no mutable field fails closed", () => {
  assert.throws(
    () => parseActionDecision({ type: "UPDATE_WORK_ORDER", reason: "No change.", workOrderCode: "WO-2026-004" }),
    rejectsWithAnyPipeError()
  );
});

test("17d. the action boundary rejects an extra key and an unknown type", () => {
  assert.throws(
    () => parseActionDecision({ type: "NO_ACTION", reason: "ok", confidence: 0.8 }),
    rejectsWithAnyPipeError()
  );
  assert.throws(
    () => parseActionDecision({ type: "DELETE_EVERYTHING", reason: "nope" }),
    rejectsWithAnyPipeError()
  );
});

test("17e. a live action payload survives the full string to Zod pipeline", async () => {
  await withLiveEnv(async () => {
    const log = callLog(async () => jsonResponse({ response: JSON.stringify(ACTION_VARIANTS[0].payload) }));

    const live = await chatWithLyzr({ role: "action", message: "choose an action" }, { fetchImpl: log.fetchImpl });
    const parsed = parseActionDecision(parseAgentJson(live.content));

    assert.equal(live.mock, false);
    assert.equal(parsed.type, "CREATE_WORK_ORDER");

    const bad = callLog(
      async () => jsonResponse({ response: JSON.stringify({ ...ACTION_VARIANTS[0].payload, sql: "DROP TABLE" }) })
    );
    const badLive = await chatWithLyzr({ role: "action", message: "choose an action" }, { fetchImpl: bad.fetchImpl });
    assert.throws(() => parseActionDecision(parseAgentJson(badLive.content)), rejectsWithAnyPipeError());
  });
});

const NOW = new Date("2026-09-25T10:00:00.000Z");
const P204_ID = ASSET_UUID;

interface WorkflowState {
  workOrders: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  writes: number;
}

function seedState(): WorkflowState {
  return { workOrders: [], incidents: [], writes: 0 };
}

function fakeClient(state: WorkflowState) {
  const technician = {
    id: "tech-1",
    code: "TECH-001",
    name: "Andi Pratama",
    specialization: "Mechanical",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const plant = {
    id: "plant-a",
    code: "PLANT-A",
    name: "Cikarang Manufacturing Plant",
    location: "Cikarang",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const asset = {
    id: P204_ID,
    code: "P-204",
    name: "Cooling Water Pump",
    manufacturer: "Grundfos",
    model: "CR 32-4",
    status: "CRITICAL",
    plantId: plant.id,
    createdAt: NOW,
    updatedAt: NOW,
    plant,
    incidents: [] as Array<Record<string, unknown>>,
    maintenanceRecords: [] as Array<Record<string, unknown>>,
    workOrders: [] as Array<Record<string, unknown>>,
    sops: [] as Array<Record<string, unknown>>,
  };
  const openWorkOrder = {
    id: "wo-open",
    code: "WO-2026-004",
    assetId: asset.id,
    title: "Follow-up intake system inspection",
    description: "Inspect the intake filter.",
    priority: "HIGH",
    status: "OPEN",
    scheduledAt: NOW,
    completedAt: null,
    technicianId: technician.id,
    createdAt: NOW,
    updatedAt: NOW,
    technician,
  };
  asset.workOrders.push(openWorkOrder);
  state.workOrders.push(openWorkOrder);

  const client = {
    asset: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id?.toLowerCase() === asset.id.toLowerCase() || where.code === asset.code) return asset;
        return null;
      },
    },
    technician: { findUnique: async () => technician },
    workOrder: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) =>
        state.workOrders.find((record) => record.id === where.id || record.code === where.code) ?? null,
      findFirst: async ({ where }: { where: { assetId?: string; status?: string } }) =>
        state.workOrders.find(
          (record) =>
            (!where.assetId || record.assetId === where.assetId) &&
            (!where.status || record.status === where.status)
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `wo-${state.workOrders.length + 1}`, createdAt: NOW, updatedAt: NOW, technician, ...data };
        state.workOrders.push(record);
        asset.workOrders.push(record);
        state.writes += 1;
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = state.workOrders.find((item) => item.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data, { updatedAt: NOW });
        state.writes += 1;
        return record;
      },
    },
    incident: {
      findUnique: async () => state.incidents[0] ?? null,
      findFirst: async () => state.incidents[0] ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `incident-${state.incidents.length + 1}`, createdAt: NOW, updatedAt: NOW, ...data };
        state.incidents.push(record);
        state.writes += 1;
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = state.incidents.find((item) => item.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data, { updatedAt: NOW });
        state.writes += 1;
        return record;
      },
      updateMany: async () => ({ count: 0 }),
    },
    maintenanceRecord: {
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        state.writes += 1;
        return { id: "obs-1", createdAt: NOW, updatedAt: NOW, ...data };
      },
    },
  };

  return { client: client as unknown as PrismaClient, asset };
}

function sopRetrieval() {
  return {
    docs: [
      {
        id: "SOP-014",
        text: "P-204 intake filter inspection procedure. Inspect contamination and verify vibration after restart.",
        content: "P-204 intake filter inspection procedure.",
        memoryId: "SOP-014",
        score: 0.97,
        metadata: { type: "sop", asset_code: "P-204", plant_code: "PLANT-A", source: "postgres" },
      },
    ],
    latencyMs: 2,
    collectionName: "fieldos-knowledge",
    query: "P-204 abnormal vibration",
  };
}

function failingMemory(): Promise<MemoryPersistenceStatus> {
  return Promise.resolve({ attempted: false, persisted: false });
}

test("18. orchestrator regression: the mock path still creates and verifies one work order", async () => {
  await withMockEnv(async () => {
    const state = seedState();
    const { client } = fakeClient(state);
    let persistCalls = 0;
    let assetRetrievals = 0;

    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
        timestamp: NOW.toISOString(),
        sessionId: "phase6-regression",
      },
      {
        client,
        retrieve: async () => {
          assetRetrievals += 1;
          return sopRetrieval();
        },
        retrieveContext: async () => sopRetrieval(),
        persistMemory: async () => {
          persistCalls += 1;
          return { attempted: true, persisted: true, memoryId: "agent-result:create_work_order:phase6" };
        },
        now: () => NOW,
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(result.workflow?.status, "completed");
    assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");
    assert.equal(result.workflow?.action?.entity, "work_order");
    assert.equal(result.workflow?.action?.assetCode, "P-204");
    assert.equal(result.workflow?.verification?.success, true);
    assert.equal(state.writes, 1, "exactly one write, as before");
    assert.equal(state.workOrders.length, 2);
    assert.match(String(state.workOrders[1].code), /^WO-P204-[A-F0-9]{10}$/);
    assert.equal(persistCalls, 1, "a verified action persists exactly one agent-result memory");
    assert.equal(assetRetrievals, 1);
  });
});

test("19. no unintended writes: a clarification run performs no mutation and no memory write", async () => {
  await withMockEnv(async () => {
    const state = seedState();
    const { client } = fakeClient(state);
    let persistCalls = 0;
    let assetRetrievals = 0;

    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204-004 is making abnormal vibration.",
        timestamp: NOW.toISOString(),
        sessionId: "phase6-clarification",
      },
      {
        client,
        retrieve: async () => {
          assetRetrievals += 1;
          return sopRetrieval();
        },
        retrieveContext: async () => sopRetrieval(),
        persistMemory: async () => {
          persistCalls += 1;
          return failingMemory();
        },
        now: () => NOW,
      }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(result.workflow?.action, null);
    assert.equal(result.workflow?.verification, null);
    assert.equal(state.writes, 0);
    assert.equal(state.workOrders.length, 1);
    assert.equal(persistCalls, 0);
    assert.equal(assetRetrievals, 0, "an unresolved reference must not even reach retrieval");
  });
});

function memoryDoc(options: {
  memoryId: string;
  type: string;
  score: number;
  assetId?: string;
  assetCode: string;
  source?: string;
}): QdrantDocument {
  const { memoryId, type, score, assetCode } = options;
  return {
    id: memoryId,
    text: `${assetCode} record ${memoryId} describing a field report and its outcome.`,
    content: `${assetCode} record ${memoryId}`,
    memoryId,
    score,
    type,
    assetId: options.assetId,
    plantId: "plant-a",
    source: options.source ?? "postgres",
    metadata: {
      type,
      asset_id: options.assetId ?? "",
      asset_code: assetCode,
      plant_code: "PLANT-A",
      source: options.source ?? "postgres",
    },
  };
}

test("20. Qdrant is untouched on a read-only memory recall", async () => {
  await withMockEnv(async () => {
    const state = seedState();
    const { client } = fakeClient(state);
    let persistCalls = 0;
    let assetRetrievals = 0;
    const LATER = "2026-09-26T11:00:00.000Z";

    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "What's the status of the pump I reported yesterday?",
        timestamp: LATER,
        sessionId: "phase6-recall",
      },
      {
        client,
        retrieve: async () => {
          assetRetrievals += 1;
          return sopRetrieval();
        },
        retrieveContext: async () => ({
          docs: [
            memoryDoc({
              memoryId: "agent-result:create_work_order:phase6-anchor",
              type: "AGENT_RESULT",
              score: 0.4988,
              assetId: P204_ID,
              assetCode: "P-204",
              source: "workflow",
            }),
          ],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: "status of the pump I reported yesterday",
        }),
        persistMemory: async () => {
          persistCalls += 1;
          return { attempted: true, persisted: true, memoryId: "agent-result:create_work_order:phase6-new" };
        },
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(result.workflow?.status, "completed");
    assert.equal(trace.assetResolution?.basis, "agent_result_memory");
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(result.workflow?.action, null);
    assert.equal(result.workflow?.verification, null);
    assert.equal(state.writes, 0, "a recall must not mutate the database");
    assert.equal(state.workOrders.length, 1);
    assert.equal(persistCalls, 0, "a recall must not write to Qdrant");
    assert.equal(
      assetRetrievals,
      1,
      "the investigation stage still performs one read-only Qdrant search"
    );
    assert.match(result.answer, /Current PostgreSQL work order WO-2026-004 for P-204 is OPEN/);
  });
});

test("20b. a recall still fails closed when the memory spans two assets", async () => {
  await withMockEnv(async () => {
    const state = seedState();
    const { client } = fakeClient(state);
    let assetRetrievals = 0;
    const LATER = "2026-09-26T11:00:00.000Z";

    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "What's the status of the pump I reported yesterday?",
        timestamp: LATER,
        sessionId: "phase6-recall-ambiguous",
      },
      {
        client,
        retrieve: async () => {
          assetRetrievals += 1;
          return sopRetrieval();
        },
        retrieveContext: async () => ({
          docs: [
            memoryDoc({ memoryId: "work-order:P204", type: "WORK_ORDER", score: 0.61, assetId: P204_ID, assetCode: "P-204" }),
            memoryDoc({
              memoryId: "work-order:M101",
              type: "WORK_ORDER",
              score: 0.6,
              assetId: "a0000000-0000-4000-8000-000000000101",
              assetCode: "M-101",
            }),
          ],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: "status of the pump I reported yesterday",
        }),
        persistMemory: failingMemory,
        now: () => new Date(LATER),
      }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(state.writes, 0);
    assert.equal(assetRetrievals, 0, "an ambiguous memory must not reach asset-scoped retrieval");
  });
});

test("21. the live path never mutates a database because the client has no write surface", async () => {
  await withLiveEnv(async () => {
    const state = seedState();
    const { client } = fakeClient(state);
    const before = { workOrders: state.workOrders.length, writes: state.writes };

    const payloads = [
      JSON.stringify(VALID_TRIAGE),
      JSON.stringify({ findings: ["Vibration."], recommendedAction: "NO_ACTION", rationale: "None." }),
      JSON.stringify(ACTION_VARIANTS[5].payload),
      JSON.stringify({ success: true, summary: "Verified." }),
    ];
    let index = 0;
    const fetchImpl: LyzrFetch = async () => jsonResponse({ response: payloads[index++] ?? payloads[0] });

    for (const role of ["triage", "investigation", "action", "verification"] as const) {
      const live = await chatWithLyzr({ role, message: `run ${role}` }, { fetchImpl });
      assert.equal(live.mock, false);
    }

    assert.equal(state.writes, before.writes);
    assert.equal(state.workOrders.length, before.workOrders);
    assert.equal(client === undefined, false);
  });
});

test("22. the timeout and retry defaults are 20000 ms and 2 retries", async () => {
  await withLiveEnv(async () => {
    const config = getLyzrConfig();
    assert.equal(config.timeoutMs, 20_000);
    assert.equal(config.maxRetries, 2);
  });
});

test("22b. invalid timeout and retry values fall back to the defaults", async () => {
  await withLiveEnv(
    async () => {
      const config = getLyzrConfig();
      assert.equal(config.timeoutMs, 20_000);
      assert.equal(config.maxRetries, 2);
    },
    { LYZR_TIMEOUT_MS: "not-a-number", LYZR_MAX_RETRIES: "abc" }
  );
});

test("22c. configured timeout and retry values are honoured", async () => {
  await withLiveEnv(
    async () => {
      const config = getLyzrConfig();
      assert.equal(config.timeoutMs, 7_500);
      assert.equal(config.maxRetries, 5);
    },
    { LYZR_TIMEOUT_MS: "7500", LYZR_MAX_RETRIES: "5" }
  );
});

test("23. a fenced live response still parses, and surrounding prose still fails closed", async () => {
  await withLiveEnv(async () => {
    const fenced = callLog(async () =>
      jsonResponse({ response: `\`\`\`json\n${JSON.stringify(VALID_TRIAGE)}\n\`\`\`` })
    );
    const fencedLive = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: fenced.fetchImpl });
    const fencedParsed = parseTriageResult(parseAgentJson(fencedLive.content));
    assert.equal(fencedParsed.intent, "CHECK_STATUS");

    const noisy = callLog(async () =>
      jsonResponse({ response: `Here you go:\n${JSON.stringify(VALID_TRIAGE)}\nHope that helps!` })
    );
    const noisyLive = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: noisy.fetchImpl });
    const noisyParsed = parseTriageResult(parseAgentJson(noisyLive.content));
    assert.equal(noisyParsed.intent, "CHECK_STATUS");

    const prose = callLog(async () => jsonResponse({ response: "The pump probably needs a work order." }));
    const proseLive = await chatWithLyzr(TRIAGE_INPUT, { fetchImpl: prose.fetchImpl });
    assert.throws(() => parseTriageResult(parseAgentJson(proseLive.content)), rejectsWith("lyzr_malformed"));
  });
});

test("24. the same live request rejects at every role boundary consistently", async () => {
  const badEnum = { findings: ["x"], recommendedAction: "DELETE_ALL", rationale: "y" };

  assert.throws(
    () => parseInvestigationResult(parseAgentJson(JSON.stringify(badEnum))),
    rejectsWith("lyzr_malformed")
  );
  assert.throws(
    () => parseTriageResult(parseAgentJson(JSON.stringify({ intent: "REPORT_ISSUE", severity: "EXTREME" }))),
    rejectsWith("lyzr_malformed")
  );
  assert.throws(
    () => parseActionDecision(parseAgentJson(JSON.stringify({ type: "NO_ACTION", reason: "" }))),
    rejectsWithAnyPipeError()
  );
});

const LIVE_ACTION_ENVELOPE: Record<string, unknown> = {
  actionType: "CREATE_WORK_ORDER",
  assetId: ASSET_UUID,
  title: "Inspect intake filter",
  description: "Vibration follow-up inspection.",
  reason: "Reported abnormal vibration.",
  priority: "HIGH",
  workOrderId: null,
  workOrderCode: null,
  code: null,
  status: null,
  technicianId: null,
  scheduledAt: null,
  rootCause: null,
  severity: null,
  incidentId: null,
  incidentCode: null,
  clarification: null,
};

const ALL_KNOWN_ACTION_FIELDS = [
  "assetId",
  "title",
  "description",
  "reason",
  "code",
  "technicianId",
  "priority",
  "status",
  "scheduledAt",
  "completedAt",
  "workOrderId",
  "workOrderCode",
  "rootCause",
  "severity",
  "occurredAt",
  "resolvedAt",
  "actionTaken",
  "performedAt",
  "incidentId",
  "incidentCode",
  "clarification",
] as const;

const VALID_ACTION_FIELDS: Record<string, readonly string[]> = {
  CREATE_WORK_ORDER: [
    "assetId",
    "title",
    "description",
    "reason",
    "code",
    "technicianId",
    "priority",
    "status",
    "scheduledAt",
    "completedAt",
  ],
  UPDATE_WORK_ORDER: [
    "reason",
    "workOrderId",
    "workOrderCode",
    "assetId",
    "title",
    "description",
    "technicianId",
    "priority",
    "status",
    "scheduledAt",
    "completedAt",
  ],
  CREATE_INCIDENT: [
    "assetId",
    "title",
    "description",
    "rootCause",
    "reason",
    "severity",
    "code",
    "technicianId",
    "occurredAt",
    "resolvedAt",
  ],
  RECORD_OBSERVATION: [
    "assetId",
    "title",
    "description",
    "reason",
    "code",
    "technicianId",
    "actionTaken",
    "performedAt",
  ],
  ESCALATE_INCIDENT: ["reason", "incidentId", "incidentCode", "severity"],
  NO_ACTION: ["reason", "clarification"],
  NEEDS_CLARIFICATION: ["reason", "clarification"],
};

function foreignNulls(variant: string): Record<string, null> {
  const valid = VALID_ACTION_FIELDS[variant];
  const envelope: Record<string, null> = {};
  for (const field of ALL_KNOWN_ACTION_FIELDS) {
    if (!valid.includes(field)) envelope[field] = null;
  }
  return envelope;
}

function pipeErrorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(
      error instanceof PipeError,
      `expected a PipeError, received ${String(error)}`
    );
    return error.message;
  }
  assert.fail("expected the action boundary to throw");
}

test("25. the exact live envelope parses into a valid CREATE_WORK_ORDER", () => {
  const parsed = parseActionDecision(LIVE_ACTION_ENVELOPE);

  assert.equal(parsed.type, "CREATE_WORK_ORDER");
  assert.equal(Object.hasOwn(parsed, "actionType"), false);
  for (const key of [
    "workOrderId",
    "workOrderCode",
    "code",
    "status",
    "technicianId",
    "scheduledAt",
    "rootCause",
    "severity",
    "incidentId",
    "incidentCode",
    "clarification",
  ]) {
    assert.equal(Object.hasOwn(parsed, key), false, key);
  }
  assert.deepEqual(Object.keys(parsed).sort(), [
    "assetId",
    "description",
    "priority",
    "reason",
    "title",
    "type",
  ]);
});

test("26. the same envelope keyed by type is accepted unchanged", () => {
  const { actionType: _alias, ...typed } = LIVE_ACTION_ENVELOPE;
  const parsed = parseActionDecision({ type: "CREATE_WORK_ORDER", ...typed });

  assert.equal(parsed.type, "CREATE_WORK_ORDER");
  assert.deepEqual(Object.keys(parsed).sort(), [
    "assetId",
    "description",
    "priority",
    "reason",
    "title",
    "type",
  ]);
});

test("27. required CREATE_WORK_ORDER nulls still fail closed", () => {
  for (const field of ["assetId", "priority", "title", "description", "reason"]) {
    const message = pipeErrorMessage(() =>
      parseActionDecision({ ...LIVE_ACTION_ENVELOPE, [field]: null })
    );
    assert.match(message, new RegExp(field), field);
    assert.doesNotMatch(message, /Invalid discriminator value/, field);
  }
});

test("28. an invalid CREATE_WORK_ORDER enum still fails closed", () => {
  const message = pipeErrorMessage(() =>
    parseActionDecision({ ...LIVE_ACTION_ENVELOPE, priority: "URGENT" })
  );
  assert.match(message, /priority/);
  assert.doesNotMatch(message, /Invalid discriminator value/);
});

test("29. unknown keys survive normalization so strict still rejects them", () => {
  for (const key of ["confidence", "sql", "table", "notes"]) {
    for (const value of [null, 0.8, "DROP TABLE assets"]) {
      assert.throws(
        () => parseActionDecision({ ...LIVE_ACTION_ENVELOPE, [key]: value }),
        rejectsWithAnyPipeError(),
        `${key}=${String(value)}`
      );
    }
  }
});

test("30. cross-variant nulls are stripped and never aliased onto a valid field", () => {
  const withNullsOnly = parseActionDecision({
    actionType: "CREATE_WORK_ORDER",
    assetId: ASSET_UUID,
    title: "Inspect intake filter",
    description: "Vibration follow-up inspection.",
    reason: "Reported abnormal vibration.",
    priority: "HIGH",
    workOrderId: null,
    workOrderCode: null,
  });

  assert.equal(withNullsOnly.type, "CREATE_WORK_ORDER");
  assert.equal(Object.hasOwn(withNullsOnly, "code"), false);
  assert.equal(Object.hasOwn(withNullsOnly, "workOrderCode"), false);
  assert.equal(Object.hasOwn(withNullsOnly, "workOrderId"), false);

  const withCode = parseActionDecision({
    actionType: "CREATE_WORK_ORDER",
    assetId: ASSET_UUID,
    title: "Inspect intake filter",
    description: "Vibration follow-up inspection.",
    reason: "Reported abnormal vibration.",
    priority: "HIGH",
    code: "WO-2026-004",
  });
  assert.equal(Object.hasOwn(withCode, "workOrderCode"), false);
  assert.equal(Object.hasOwn(withCode, "code"), true);
});

test("31. a non-null cross-variant value is preserved for production validation", () => {
  assert.throws(
    () =>
      parseActionDecision({
        ...LIVE_ACTION_ENVELOPE,
        status: "INVALID_STATUS",
      }),
    rejectsWithAnyPipeError()
  );
  assert.throws(
    () =>
      parseActionDecision({
        ...LIVE_ACTION_ENVELOPE,
        workOrderCode: "WO-2026-004",
      }),
    rejectsWithAnyPipeError()
  );
});

test("32. UPDATE_WORK_ORDER accepts an identity, a mutable field and a null envelope", () => {
  const parsed = parseActionDecision({
    ...foreignNulls("UPDATE_WORK_ORDER"),
    actionType: "UPDATE_WORK_ORDER",
    reason: "Escalating the priority.",
    workOrderCode: "WO-2026-004",
    priority: "CRITICAL",
  });

  assert.equal(parsed.type, "UPDATE_WORK_ORDER");
  assert.equal(Object.hasOwn(parsed, "rootCause"), false);
  assert.equal(Object.hasOwn(parsed, "clarification"), false);
  assert.equal(Object.hasOwn(parsed, "actionType"), false);
});

test("33. UPDATE_WORK_ORDER without any surviving identity fails closed", () => {
  const message = pipeErrorMessage(() =>
    parseActionDecision({
      actionType: "UPDATE_WORK_ORDER",
      reason: "No identifier.",
      workOrderId: null,
      workOrderCode: null,
      priority: "HIGH",
    })
  );
  assert.match(message, /workOrderId or workOrderCode/);
});

test("34. UPDATE_WORK_ORDER with only null mutable fields fails the existing refinement", () => {
  const message = pipeErrorMessage(() =>
    parseActionDecision({
      actionType: "UPDATE_WORK_ORDER",
      reason: "No change.",
      workOrderCode: "WO-2026-004",
      assetId: null,
      title: null,
      description: null,
      technicianId: null,
      priority: null,
      status: null,
      scheduledAt: null,
    })
  );
  assert.match(message, /at least one mutable field/);

  const nullableKept = parseActionDecision({
    actionType: "UPDATE_WORK_ORDER",
    reason: "Closing the work order.",
    workOrderCode: "WO-2026-004",
    completedAt: null,
  });
  assert.equal(nullableKept.type, "UPDATE_WORK_ORDER");
  assert.equal(Object.hasOwn(nullableKept, "completedAt"), true);
});

test("35. CREATE_INCIDENT accepts a null envelope and rejects a null assetId", () => {
  const parsed = parseActionDecision({
    actionType: "CREATE_INCIDENT",
    assetId: ASSET_UUID,
    title: "Unexpected pump shutdown",
    description: "The pump stopped unexpectedly.",
    rootCause: "Intake filter blockage.",
    reason: "Field report.",
    severity: "CRITICAL",
    code: null,
    technicianId: null,
    occurredAt: null,
    resolvedAt: null,
    workOrderId: null,
    workOrderCode: null,
    status: null,
    scheduledAt: null,
    completedAt: null,
    priority: null,
    incidentId: null,
    incidentCode: null,
    clarification: null,
  });

  assert.equal(parsed.type, "CREATE_INCIDENT");
  assert.equal(Object.hasOwn(parsed, "priority"), false);
  assert.equal(Object.hasOwn(parsed, "clarification"), false);

  const message = pipeErrorMessage(() =>
    parseActionDecision({
      actionType: "CREATE_INCIDENT",
      assetId: null,
      title: "Unexpected pump shutdown",
      description: "The pump stopped unexpectedly.",
      rootCause: "Intake filter blockage.",
      reason: "Field report.",
      severity: "CRITICAL",
    })
  );
  assert.match(message, /assetId/);
});

test("36. RECORD_OBSERVATION accepts a null envelope", () => {
  const parsed = parseActionDecision({
    actionType: "RECORD_OBSERVATION",
    assetId: ASSET_UUID,
    title: "Operator observation",
    description: "Noted abnormal noise during walkaround.",
    reason: "Routine walkaround.",
    code: null,
    technicianId: null,
    actionTaken: null,
    performedAt: null,
    workOrderId: null,
    workOrderCode: null,
    status: null,
    scheduledAt: null,
    completedAt: null,
    rootCause: null,
    severity: null,
    incidentId: null,
    incidentCode: null,
    clarification: null,
  });

  assert.equal(parsed.type, "RECORD_OBSERVATION");
  assert.equal(Object.hasOwn(parsed, "actionTaken"), false);
});

test("37. ESCALATE_INCIDENT requires a surviving identity", () => {
  const parsed = parseActionDecision({
    actionType: "ESCALATE_INCIDENT",
    reason: "Severity increased after inspection.",
    incidentCode: "INC-2026-002",
    incidentId: null,
    severity: "CRITICAL",
    workOrderId: null,
    workOrderCode: null,
    code: null,
    status: null,
    technicianId: null,
    scheduledAt: null,
    rootCause: null,
    assetId: null,
    title: null,
    description: null,
    clarification: null,
  });

  assert.equal(parsed.type, "ESCALATE_INCIDENT");
  assert.equal(Object.hasOwn(parsed, "incidentId"), false);
  assert.equal(Object.hasOwn(parsed, "clarification"), false);

  const message = pipeErrorMessage(() =>
    parseActionDecision({
      actionType: "ESCALATE_INCIDENT",
      reason: "No incident identified.",
      incidentId: null,
      incidentCode: null,
      severity: "CRITICAL",
    })
  );
  assert.match(message, /incidentId or incidentCode/);
});

test("38. NO_ACTION drops an optional null clarification but keeps every rule", () => {
  const parsed = parseActionDecision({
    actionType: "NO_ACTION",
    reason: "The evidence does not ground a mutation.",
    clarification: null,
  });

  assert.equal(parsed.type, "NO_ACTION");
  assert.equal(Object.hasOwn(parsed, "actionType"), false);
  assert.equal(Object.hasOwn(parsed, "clarification"), false);

  const withQuestion = parseActionDecision({
    actionType: "NO_ACTION",
    reason: "Ambiguous but not blocking.",
    clarification: "Which pump do you mean?",
  });
  assert.equal(Object.hasOwn(withQuestion, "clarification"), true);

  const missingReason = pipeErrorMessage(() =>
    parseActionDecision({ actionType: "NO_ACTION", clarification: null })
  );
  assert.match(missingReason, /reason/);
  assert.doesNotMatch(missingReason, /Invalid discriminator value/);

  assert.throws(
    () => parseActionDecision({ actionType: "NO_ACTION", reason: "ok", confidence: null }),
    rejectsWithAnyPipeError()
  );
  assert.throws(
    () => parseActionDecision({ actionType: "NO_ACTION", reason: "ok", sql: null }),
    rejectsWithAnyPipeError()
  );
});

test("39. NEEDS_CLARIFICATION keeps a null or missing clarification rejected", () => {
  const parsed = parseActionDecision({
    actionType: "NEEDS_CLARIFICATION",
    reason: "The referenced asset is ambiguous.",
    clarification: "Which pump do you mean?",
    assetId: null,
    priority: null,
  });

  assert.equal(parsed.type, "NEEDS_CLARIFICATION");
  assert.equal(Object.hasOwn(parsed, "assetId"), false);
  assert.equal(Object.hasOwn(parsed, "priority"), false);

  for (const payload of [
    { actionType: "NEEDS_CLARIFICATION", reason: "Ambiguous.", clarification: null },
    { actionType: "NEEDS_CLARIFICATION", reason: "Ambiguous." },
  ]) {
    const message = pipeErrorMessage(() => parseActionDecision(payload));
    assert.match(message, /clarification/);
    assert.doesNotMatch(message, /Invalid discriminator value/);
  }

  assert.throws(
    () =>
      parseActionDecision({
        actionType: "NEEDS_CLARIFICATION",
        reason: "Ambiguous.",
        clarification: "Which pump?",
        confidence: null,
      }),
    rejectsWithAnyPipeError()
  );
});

test("40. both discriminator keys are accepted and collapse to one canonical type", () => {
  for (const variant of ACTION_VARIANTS) {
    const aliased: Record<string, unknown> = { ...variant.payload };
    aliased.actionType = aliased.type;
    delete aliased.type;
    assert.equal(parseActionDecision(aliased).type, variant.expectedType, variant.label);

    const both = parseActionDecision({ ...variant.payload, actionType: variant.payload.type });
    assert.equal(both.type, variant.expectedType, variant.label);
    assert.equal(Object.hasOwn(both, "actionType"), false, variant.label);
  }
  assert.equal(ACTION_VARIANTS.length, 7);
});

test("41. conflicting or unknown discriminators still fail closed", () => {
  const conflict = pipeErrorMessage(() =>
    parseActionDecision({
      type: "CREATE_WORK_ORDER",
      actionType: "UPDATE_WORK_ORDER",
      assetId: ASSET_UUID,
      title: "Inspect intake filter",
      description: "Vibration follow-up inspection.",
      reason: "Reported abnormal vibration.",
      priority: "HIGH",
    })
  );
  assert.match(conflict, /conflicting/);

  const specialConflict = pipeErrorMessage(() =>
    parseActionDecision({
      type: "NO_ACTION",
      actionType: "NEEDS_CLARIFICATION",
      reason: "Ambiguous.",
      clarification: "Which pump?",
    })
  );
  assert.match(specialConflict, /conflicting/);

  for (const payload of [
    { actionType: "DELETE_EVERYTHING", reason: "nope" },
    { actionType: "CREATE_WORK_ORDER_V2", reason: "nope" },
    { actionType: null, reason: "nope" },
    { reason: "nope" },
  ]) {
    assert.throws(() => parseActionDecision(payload), rejectsWithAnyPipeError(), JSON.stringify(payload));
  }
});

test("42. normalization is a boundary adapter and leaves parseActionRequest strict", () => {
  assert.throws(
    () => parseActionRequest(LIVE_ACTION_ENVELOPE),
    rejectsWithAnyPipeError()
  );
  assert.equal(parseActionDecision(LIVE_ACTION_ENVELOPE).type, "CREATE_WORK_ORDER");

  const normalized = parseActionDecision(LIVE_ACTION_ENVELOPE);
  assert.equal(parseActionRequest(normalized).type, "CREATE_WORK_ORDER");

  for (const variant of ACTION_VARIANTS) {
    if (variant.expectedType === "NO_ACTION" || variant.expectedType === "NEEDS_CLARIFICATION") {
      continue;
    }
    const decorated = { ...variant.payload, ...foreignNulls(variant.expectedType) };
    assert.throws(() => parseActionRequest(decorated), rejectsWithAnyPipeError(), variant.label);
    assert.equal(parseActionDecision(decorated).type, variant.expectedType, variant.label);
  }
});

const GROUNDING_TRANSCRIPT =
  "P-204. The pump is making abnormal vibration and needs a follow-up inspection.";

/** The exact wording from the supervised live run that Investigation declined. */
const EXPLICIT_CREATE_TRANSCRIPT =
  "Pump P-204 has increased vibration again. Please create a new work order for a bearing and alignment inspection.";

const LIVE_PROSE_SUPPORTING_EVIDENCE = [
  "Prior report indicates that P-204 exhibited rising vibration over three consecutive shifts, with inspection deferred pending parts availability.",
  "SOP-BRG-01 states that escalating pump vibration requires bearing and alignment inspection before continued duty.",
];

function scoreRetrieval(score: number): ReturnType<typeof sopRetrieval> {
  return {
    docs: [{ ...sopRetrieval().docs[0], score }],
    latencyMs: 2,
    collectionName: "fieldos-knowledge",
    query: "P-204 abnormal vibration",
  };
}

/**
 * Runs the real workflow against a stubbed Lyzr transport so the live-shaped
 * Investigation response reaches the production parser and the production
 * grounding gate. The stub dispatches on agent_id, so every role still travels
 * through the real client, prompt, parseAgentJson and Zod validation.
 */
async function withStubbedLyzr<T>(
  investigation: Record<string, unknown>,
  fn: (calls: { roleOf: (role: string) => number; total: () => number }) => Promise<T>,
  triageOverride: Record<string, unknown> = {},
  actionOverride?: Record<string, unknown>
): Promise<T> {
  const previousFetch = globalThis.fetch;
  const perRole = new Map<string, number>();
  let total = 0;

  const bodies: Record<string, unknown> = {
    [AGENT_IDS.triage]: {
      intent: "REPORT_ISSUE",
      assetId: "P-204",
      plantId: null,
      issue: GROUNDING_TRANSCRIPT,
      severity: null,
      requiresInvestigation: true,
      ...triageOverride,
    },
    [AGENT_IDS.investigation]: investigation,
    [AGENT_IDS.action]: actionOverride ?? {
      type: "CREATE_WORK_ORDER",
      assetId: "P-204",
      title: "Inspect intake filter",
      description: "Bearing and alignment inspection for rising vibration.",
      reason: "Reported abnormal vibration above the grounded threshold.",
      priority: "HIGH",
    },
    [AGENT_IDS.verification]: {
      success: true,
      summary: "The work order was read back from PostgreSQL.",
    },
  };

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("/inference/chat/")) {
      throw new Error(`unexpected request target ${url}`);
    }
    total += 1;
    const agentId = (JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string }).agent_id ?? "";
    perRole.set(agentId, (perRole.get(agentId) ?? 0) + 1);
    const body = bodies[agentId];
    if (body === undefined) throw new Error(`no stub for agent ${agentId}`);
    return new Response(JSON.stringify({ response: JSON.stringify(body) }), { status: 200 });
  }) as typeof fetch;

  try {
    return await withLiveEnv(() => fn({
      roleOf: (role: string) => perRole.get(AGENT_IDS[role as keyof typeof AGENT_IDS]) ?? 0,
      total: () => total,
    }));
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const GROUNDED_INVESTIGATION = {
  findings: ["Pump P-204 is exhibiting increased vibration across three consecutive shifts."],
  probableIssue: "Bearing or alignment degradation.",
  supportingEvidence: LIVE_PROSE_SUPPORTING_EVIDENCE,
  recommendedAction: "CREATE_WORK_ORDER",
  rationale: "Sustained vibration warrants a constrained bearing and alignment inspection.",
};

async function runGroundedWorkflow(investigation: Record<string, unknown>, overrides: {
  triage?: Record<string, unknown>;
  transcript?: string;
  retrieval?: ReturnType<typeof sopRetrieval>;
  metadata?: Record<string, unknown>;
  action?: Record<string, unknown>;
} = {}) {
  const state = seedState();
  const { client } = fakeClient(state);
  let persistCalls = 0;
  let roleOf: (role: string) => number = () => 0;

  const result = await withStubbedLyzr(
    investigation,
    (observed) => {
      roleOf = observed.roleOf;
      return runInvestigationWorkflow(
        {
          source: "web",
          transcript: overrides.transcript ?? GROUNDING_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: "phase6-grounding",
          ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
        },
        {
          client,
          retrieve: async () => overrides.retrieval ?? sopRetrieval(),
          retrieveContext: async () => overrides.retrieval ?? sopRetrieval(),
          persistMemory: async () => {
            persistCalls += 1;
            return { attempted: true, persisted: true, memoryId: "agent-result:create_work_order:grounding" };
          },
          now: () => NOW,
        }
      );
    },
    overrides.triage,
    overrides.action
  );

  return { result, state, persistCalls: () => persistCalls, roleOf };
}

test("43. grounding is decided by the retrieval layer, not by prose citations", async () => {
  const { result, state } = await runGroundedWorkflow(GROUNDED_INVESTIGATION);

  assert.equal(result.workflow?.status, "completed");
  assert.equal(result.workflow?.investigation?.recommendedAction, "CREATE_WORK_ORDER");
  assert.equal(result.workflow?.action?.entity, "work_order");
  assert.equal(result.workflow?.action?.assetCode, "P-204");
  assert.equal(result.workflow?.verification?.success, true);
  assert.equal(state.writes, 1, "exactly one Prisma write");
});

test("44. grounding still passes when the agent cites nothing at all", async () => {
  const { result, state } = await runGroundedWorkflow({
    ...GROUNDED_INVESTIGATION,
    supportingEvidence: [],
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");
  assert.equal(state.writes, 1, "an empty citation list does not block a grounded action");
});

test("45. grounding ignores a hallucinated evidence identifier", async () => {
  const { result, state } = await runGroundedWorkflow({
    ...GROUNDED_INVESTIGATION,
    supportingEvidence: ["sop:this-document-does-not-exist", "incident:invented-0000"],
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");
  assert.equal(state.writes, 1, "LLM-authored identifiers are never trusted by the gate");
});

test("46. grounding fails closed on an empty retrieval", async () => {
  const state = seedState();
  const { client } = fakeClient(state);
  let persistCalls = 0;

  const result = await withStubbedLyzr(GROUNDED_INVESTIGATION, () =>
    runInvestigationWorkflow(
      {
        source: "web",
        transcript: GROUNDING_TRANSCRIPT,
        timestamp: NOW.toISOString(),
        sessionId: "phase6-grounding-empty",
      },
      {
        client,
        retrieve: async () => ({ docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" }),
        retrieveContext: async () => ({ docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" }),
        persistMemory: async () => {
          persistCalls += 1;
          return { attempted: true, persisted: true, memoryId: "agent-result:should-not-happen" };
        },
        now: () => NOW,
      }
    )
  );

  assert.equal(result.workflow?.status, "clarification_required");
  assert.equal(result.workflow?.investigation?.recommendedAction, "NO_ACTION");
  assert.match(
    String(result.workflow?.investigation?.clarification),
    /not supported by a retrieved evidence record/
  );
  assert.equal(result.workflow?.action, null);
  assert.equal(result.workflow?.verification, null);
  assert.equal(state.writes, 0, "no Prisma write");
  assert.equal(persistCalls, 0, "no memory persistence");

  const actionStep = result.workflow?.trace.agents.find((agent) => agent.role === "action");
  assert.equal(actionStep?.status, "skipped", "the action agent is recorded as skipped");
  const verificationStep = result.workflow?.trace.agents.find((agent) => agent.role === "verification");
  assert.equal(verificationStep?.status, "skipped", "verification is recorded as skipped");
});

test("47. grounding fails closed when every document scores below the threshold", async () => {
  const state = seedState();
  const { client } = fakeClient(state);
  let persistCalls = 0;

  const result = await withStubbedLyzr(GROUNDED_INVESTIGATION, () =>
    runInvestigationWorkflow(
      {
        source: "web",
        transcript: GROUNDING_TRANSCRIPT,
        timestamp: NOW.toISOString(),
        sessionId: "phase6-grounding-low",
      },
      {
        client,
        retrieve: async () => scoreRetrieval(0.2),
        retrieveContext: async () => scoreRetrieval(0.2),
        persistMemory: async () => {
          persistCalls += 1;
          return { attempted: true, persisted: true, memoryId: "agent-result:should-not-happen" };
        },
        now: () => NOW,
      }
    )
  );

  assert.equal(result.workflow?.status, "clarification_required");
  assert.equal(result.workflow?.investigation?.recommendedAction, "NO_ACTION");
  assert.equal(state.writes, 0);
  assert.equal(persistCalls, 0);
});

test("48. the grounding threshold boundary is inclusive and exact", async () => {
  for (const score of [0.25, 0.2501, 0.9]) {
    const state = seedState();
    const { client } = fakeClient(state);
    const result = await withStubbedLyzr(GROUNDED_INVESTIGATION, () =>
      runInvestigationWorkflow(
        {
          source: "web",
          transcript: GROUNDING_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: `phase6-boundary-${score}`,
        },
        {
          client,
          retrieve: async () => scoreRetrieval(score),
          retrieveContext: async () => scoreRetrieval(score),
          persistMemory: async () => ({ attempted: false, persisted: false }),
          now: () => NOW,
        }
      )
    );
    assert.equal(result.workflow?.status, "completed", `score ${score} must pass`);
    assert.equal(state.writes, 1, `score ${score} must execute`);
  }

  for (const score of [0.2499, 0.2, 0]) {
    const state = seedState();
    const { client } = fakeClient(state);
    const result = await withStubbedLyzr(GROUNDED_INVESTIGATION, () =>
      runInvestigationWorkflow(
        {
          source: "web",
          transcript: GROUNDING_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: `phase6-boundary-${score}`,
        },
        {
          client,
          retrieve: async () => scoreRetrieval(score),
          retrieveContext: async () => scoreRetrieval(score),
          persistMemory: async () => ({ attempted: false, persisted: false }),
          now: () => NOW,
        }
      )
    );
    assert.equal(result.workflow?.status, "clarification_required", `score ${score} must block`);
    assert.equal(result.workflow?.investigation?.recommendedAction, "NO_ACTION", `score ${score}`);
    assert.equal(state.writes, 0, `score ${score} must not write`);
  }
});

test("49. the grounding gate does not apply to a non-REPORT_ISSUE intent", async () => {
  const state = seedState();
  const { client } = fakeClient(state);

  const result = await withStubbedLyzr(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "CREATE_WORK_ORDER",
    },
    () =>
      runInvestigationWorkflow(
        {
          source: "web",
          transcript: "What is the status of the work order for P-204?",
          timestamp: NOW.toISOString(),
          sessionId: "phase6-grounding-check-status",
        },
        {
          client,
          retrieve: async () => ({ docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" }),
          retrieveContext: async () => ({ docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" }),
          persistMemory: async () => ({ attempted: false, persisted: false }),
          now: () => NOW,
        }
      ),
    {
      intent: "CHECK_STATUS",
      assetId: "P-204",
      issue: "Status check for P-204",
      requiresInvestigation: false,
    }
  );

  assert.equal(result.workflow?.status, "completed", "the gate must not force a clarification");
  assert.doesNotMatch(
    String(result.workflow?.investigation?.clarification),
    /not supported by a retrieved evidence record/,
    "the grounding override must not have fired"
  );
  assert.equal(result.workflow?.action, null);
  assert.equal(state.writes, 0, "a status check still never mutates");
});

test("50. an investigation clarification still returns early with no writes", async () => {
  const state = seedState();
  const { client } = fakeClient(state);
  let persistCalls = 0;

  const result = await withStubbedLyzr(
    {
      ...GROUNDED_INVESTIGATION,
      clarification: "Which pump do you mean?",
    },
    () =>
      runInvestigationWorkflow(
        {
          source: "web",
          transcript: GROUNDING_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: "phase6-grounding-clarification",
        },
        {
          client,
          retrieve: async () => sopRetrieval(),
          retrieveContext: async () => sopRetrieval(),
          persistMemory: async () => {
            persistCalls += 1;
            return { attempted: true, persisted: true, memoryId: "agent-result:should-not-happen" };
          },
          now: () => NOW,
        }
      )
  );

  assert.equal(result.workflow?.status, "clarification_required");
  assert.equal(result.answer, "Which pump do you mean?");
  assert.equal(result.workflow?.actionRequest, null);
  assert.equal(state.writes, 0);
  assert.equal(persistCalls, 0);
});

test("51. the investigation supportingEvidence contract is unchanged by the grounding fix", () => {
  const prose = parseInvestigationResult({
    findings: ["Pump P-204 is exhibiting increased vibration."],
    probableIssue: "Bearing degradation.",
    supportingEvidence: LIVE_PROSE_SUPPORTING_EVIDENCE,
    recommendedAction: "CREATE_WORK_ORDER",
    rationale: "Sustained vibration warrants inspection.",
  });

  assert.deepEqual(prose.supportingEvidence, LIVE_PROSE_SUPPORTING_EVIDENCE);
  for (const item of prose.supportingEvidence) assert.equal(typeof item, "string");

  const empty = parseInvestigationResult({
    findings: ["No evidence retrieved."],
    recommendedAction: "NO_ACTION",
    rationale: "Nothing credible to act on.",
  });

  assert.deepEqual(empty.supportingEvidence, []);

  const withIds = parseInvestigationResult({
    findings: ["A record was retrieved."],
    supportingEvidence: ["sop:SOP-014", "incident:INC-2026-002"],
    recommendedAction: "CREATE_WORK_ORDER",
    rationale: "An identifier-shaped citation is still just a string.",
  });

  assert.deepEqual(withIds.supportingEvidence, ["sop:SOP-014", "incident:INC-2026-002"]);
});

/**
 * A live triage agent answers `assetId` in prose ("Pump P-204") rather than as a stored code. The
 * first supervised live run stopped at the asset guard for exactly that reason, so the candidate the
 * orchestrator resolves against must be canonicalized while the guard itself stays exact.
 */
test("52. a prose triage assetId is canonicalized instead of failing the asset guard", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { assetId: "Pump P-204" },
  });

  const actionRequest = result.workflow?.actionRequest;
  assert.equal(result.workflow?.status, "completed");
  assert.equal(actionRequest?.type, "CREATE_WORK_ORDER");
  if (actionRequest?.type !== "CREATE_WORK_ORDER") throw new Error("expected a work order request");
  assert.equal(actionRequest.assetId, "P-204", "resolution uses the canonical code");
  assert.equal(result.workflow?.action?.entity, "work_order");
  assert.equal(result.workflow?.action?.assetCode, "P-204");
  assert.equal(result.workflow?.verification?.success, true);
  assert.equal(state.writes, 1, "exactly one Prisma write");
  assert.equal(roleOf("investigation"), 1, "investigation ran");
  assert.equal(roleOf("action"), 1, "action ran");
  assert.equal(roleOf("verification"), 1, "verification ran");
});

test("53. a triage assetId naming a different asset is still blocked", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { assetId: "M-103" },
  });

  assert.equal(result.workflow?.status, "clarification_required");
  assert.equal(state.writes, 0, "a disagreeing asset never reaches the database");
  assert.equal(result.workflow?.actionRequest, null, "no action is selected");
  assert.equal(roleOf("investigation"), 0, "the run stops at asset resolution");
  assert.equal(roleOf("action"), 0);
  assert.equal(roleOf("verification"), 0);
});

test("54. a lowercase triage assetId is canonicalized to the stored code", async () => {
  const { result, state } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { assetId: "p-204" },
  });

  const actionRequest = result.workflow?.actionRequest;
  assert.equal(result.workflow?.status, "completed");
  assert.equal(actionRequest?.type, "CREATE_WORK_ORDER");
  if (actionRequest?.type !== "CREATE_WORK_ORDER") throw new Error("expected a work order request");
  assert.equal(actionRequest.assetId, "P-204");
  assert.equal(state.writes, 1, "exactly one Prisma write");
});

test("55. a triage assetId with no asset reference is not guessed into the transcript asset", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { assetId: "Cooling Water Pump" },
    transcript: `Cooling Water Pump is vibrating again. ${GROUNDING_TRANSCRIPT}`,
  });

  assert.equal(result.workflow?.status, "clarification_required");
  assert.equal(state.writes, 0, "no write without a comparable asset reference");
  assert.equal(result.workflow?.actionRequest, null);
  assert.equal(roleOf("action"), 0);
  assert.match(
    String(result.workflow?.triage?.clarification ?? ""),
    /does not match the explicitly referenced FieldOS asset/,
    "the exact-match guard is what stops this, not a canonicalized guess"
  );
});

test("56. canonicalization is internal only and the triage record stays verbatim", async () => {
  const { result } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { assetId: "Pump P-204" },
  });

  const actionRequest = result.workflow?.actionRequest;
  assert.equal(result.workflow?.triage?.assetId, "Pump P-204", "the agent's stated value is preserved");
  assert.equal(actionRequest?.type, "CREATE_WORK_ORDER");
  if (actionRequest?.type !== "CREATE_WORK_ORDER") throw new Error("expected a work order request");
  assert.equal(actionRequest.assetId, "P-204", "the resolved action uses the canonical code");
});

/**
 * The first supervised live E2E returned `completed` and wrote nothing, because the live Triage
 * agent omitted `requiresInvestigation` and the schema's `.default(false)` then let the agent's own
 * optional boolean suppress the action stage. Whether an action is required is a backend decision,
 * so the tests below pin the deterministic policy against the LLM field.
 */
test("57. a REPORT_ISSUE is not suppressed by requiresInvestigation=false", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { requiresInvestigation: false },
  });

  assert.equal(result.workflow?.triage?.requiresInvestigation, false, "the agent's value is reported as-is");
  assert.equal(roleOf("investigation"), 1, "investigation still runs");
  assert.equal(roleOf("action"), 1, "the action stage is reached");
  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 1, "the work order is actually created");
  assert.equal(result.workflow?.action?.entity, "work_order");
});

test("58. a REPORT_ISSUE is not suppressed when requiresInvestigation is omitted", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { requiresInvestigation: undefined },
  });

  assert.equal(result.workflow?.triage?.requiresInvestigation, false, "the schema default still applies");
  assert.equal(roleOf("investigation"), 1);
  assert.equal(roleOf("action"), 1, "an omitted field cannot silently skip the action stage");
  assert.equal(state.writes, 1, "the work order is actually created");
  assert.equal(result.workflow?.action?.entity, "work_order");
});

test("59. an explicit CREATE_WORK_ORDER recommendation reaches and executes the action", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "CREATE_WORK_ORDER" },
    { triage: { requiresInvestigation: false } }
  );

  const actionRequest = result.workflow?.actionRequest;
  assert.equal(actionRequest?.type, "CREATE_WORK_ORDER");
  if (actionRequest?.type !== "CREATE_WORK_ORDER") throw new Error("expected a work order request");
  assert.equal(actionRequest.assetId, "P-204");
  assert.equal(roleOf("action"), 1);
  assert.equal(roleOf("verification"), 1, "the action is read back");
  assert.equal(state.writes, 1, "exactly one Prisma write");
  assert.equal(result.workflow?.verification?.success, true);
  assert.match(String(result.workflow?.action?.code), /^WO-P204-/, "a real work order code was written");
  assert.match(
    result.answer,
    /read back from PostgreSQL/,
    "the answer is the verification summary, so it reflects the write"
  );
  assert.doesNotMatch(result.answer, /No database change was made/);
});

test("60. CHECK_STATUS does not enter the mutation flow", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { intent: "CHECK_STATUS" },
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 0, "a status check never mutates");
  assert.equal(result.workflow?.actionRequest, null);
  assert.equal(result.workflow?.action, null);
  assert.equal(roleOf("action"), 0, "the action stage is skipped");
  assert.match(result.answer, /Current PostgreSQL work order/, "the status answer is preserved");
});

test("61. REQUEST_INFORMATION does not enter the mutation flow", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { intent: "REQUEST_INFORMATION" },
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 0, "an information request never mutates");
  assert.equal(result.workflow?.actionRequest, null);
  assert.equal(roleOf("action"), 0);
});

test("62. the deterministic policy does not weaken the grounding gate", async () => {
  const empty = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "CREATE_WORK_ORDER" },
    { triage: { requiresInvestigation: false }, retrieval: { docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" } }
  );

  assert.equal(empty.result.workflow?.status, "clarification_required", "no evidence still blocks");
  assert.equal(empty.state.writes, 0, "the gate holds even though the action stage is now reachable");
  assert.equal(empty.roleOf("action"), 0);
  assert.equal(empty.result.workflow?.investigation?.recommendedAction, "NO_ACTION");

  const below = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "CREATE_WORK_ORDER" },
    { triage: { requiresInvestigation: false }, retrieval: scoreRetrieval(0.2) }
  );

  assert.equal(below.result.workflow?.status, "clarification_required", "sub-threshold evidence still blocks");
  assert.equal(below.state.writes, 0);
  assert.equal(below.roleOf("action"), 0);
});

test("63. the deterministic policy does not weaken the asset guards", async () => {
  const mismatched = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { requiresInvestigation: false, assetId: "M-103" },
  });

  assert.equal(mismatched.result.workflow?.status, "clarification_required");
  assert.equal(mismatched.state.writes, 0, "a disagreeing asset never reaches the database");
  assert.equal(mismatched.roleOf("action"), 0);

  const unresolved = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { requiresInvestigation: false, assetId: null },
    transcript: "The pump is making abnormal vibration and needs a follow-up inspection.",
  });

  assert.equal(unresolved.result.workflow?.status, "clarification_required", "no asset reference still clarifies");
  assert.equal(unresolved.state.writes, 0);
});

test("64. a deliberate NO_ACTION is completed but is never presented as a mutation", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(
    {
      findings: ["Retrieved evidence does not establish a safe database-changing action."],
      probableIssue: "Undetermined.",
      supportingEvidence: [],
      recommendedAction: "NO_ACTION",
      rationale: "Nothing credible to act on.",
    },
    { triage: { requiresInvestigation: false } }
  );

  assert.equal(result.workflow?.status, "completed", "a declined action is still a completed workflow");
  assert.equal(state.writes, 0, "nothing was written");
  assert.equal(result.workflow?.actionRequest, null);
  assert.equal(result.workflow?.action, null);
  assert.equal(result.workflow?.trace.action, null, "no database action is reported");
  assert.equal(roleOf("action"), 0);

  const actionStep = result.workflow?.trace.agents.find((agent) => agent.role === "action");
  assert.match(String(actionStep?.decision), /NO_ACTION/, "the trace states NO_ACTION outright");
  assert.match(String(actionStep?.decision), /no database change was made/);
  assert.match(result.answer, /No database change was made/, "the answer cannot imply a work order exists");
  assert.match(result.answer, /NO_ACTION/);
});

test("65. a dropped action is distinguishable from a declined one in the trace", async () => {
  const { result, state } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    triage: { intent: "CHECK_STATUS" },
  });

  const actionStep = result.workflow?.trace.agents.find((agent) => agent.role === "action");
  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 0);
  assert.match(
    String(actionStep?.decision),
    /NOT EXECUTED · CREATE_WORK_ORDER was recommended but no database change was made/,
    "a recommended-but-unexecuted action is reported explicitly, not as a success"
  );
});

/**
 * Model A: an explicit, unconditional request to create a work order outranks an
 * investigation that recommended `NO_ACTION`, for example because a work order is
 * already open. The supervised live run that motivated this policy returned
 * `completed` with no mutation and no way for the user to insist.
 */
test("66. the requested-action parser recognizes explicit unconditional creation requests", () => {
  for (const transcript of [
    "create a new work order",
    "Please create a work order for P-204.",
    "raise a work order for P-204",
    "please file a work order",
    "open a work order for this issue",
    "generate a work order",
    "schedule a work order",
    "Pump P-204 has increased vibration. Please create a new work order for a bearing inspection.",
    "please add a work order",
  ]) {
    assert.equal(
      requestedActionFromTranscript(transcript),
      "CREATE_WORK_ORDER",
      `expected an explicit create request in: ${transcript}`
    );
  }
});

test("67. the requested-action parser abstains on status, non-create, and conditional requests", () => {
  for (const transcript of [
    "check the open work order",
    "check the work order",
    "close work order WO-2026-004",
    "what work orders are open",
    "is there a work order",
    "update the work order",
    "cancel the work order",
    "review the work order",
    "show me the work order",
    "create a work order if it isn't already done",
    "raise a work order unless one is already open",
    "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
    "",
  ]) {
    assert.equal(
      requestedActionFromTranscript(transcript),
      null,
      `expected the parser to abstain on: ${transcript}`
    );
  }
});

test("68. an explicit create request overrides an Investigation NO_ACTION and writes once", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
      rationale: "An open work order already covers this vibration.",
    },
    { transcript: EXPLICIT_CREATE_TRANSCRIPT }
  );

  assert.equal(result.workflow?.status, "completed");
  assert.equal(roleOf("action"), 1, "the action stage is reached");
  assert.equal(state.writes, 1, "the explicitly requested work order is created");
  assert.equal(result.workflow?.action?.entity, "work_order");
  assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");

  assert.equal(
    result.workflow?.investigation?.recommendedAction,
    "CREATE_WORK_ORDER",
    "the effective recommendation is the executed one"
  );
  assert.equal(
    result.workflow?.agentRecommendedAction,
    "NO_ACTION",
    "the agent's own recommendation is preserved, not overwritten"
  );
  assert.equal(result.workflow?.actionOverrideReason, "explicit_request");
  assert.deepEqual(
    result.workflow?.investigation?.existingWorkOrderCodes,
    ["WO-2026-004"],
    "the existing-work-order evidence survives the override"
  );
});

test("69. the override is visible in the trace, the answer, and the stage detail", async () => {
  const { result } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    { transcript: EXPLICIT_CREATE_TRANSCRIPT }
  );

  const actionStep = result.workflow?.trace.agents.find((agent) => agent.role === "action");
  const investigationStep = result.workflow?.trace.agents.find((agent) => agent.role === "investigation");
  assert.match(
    String(actionStep?.decision),
    /Action: CREATE_WORK_ORDER .*overridden by an explicit user request \(agent recommended NO_ACTION\)/,
    "the action trace distinguishes an override from an agent decision"
  );
  assert.match(
    String(investigationStep?.decision),
    /agent recommended: NO_ACTION/,
    "the investigation trace shows the original recommendation"
  );
  assert.match(
    String(investigationStep?.decision),
    /existing work orders: WO-2026-004/,
    "the existing work orders are surfaced as evidence"
  );
  const investigationStage = result.workflow?.trace.stages.find((stage) => stage.id === "investigation");
  assert.match(String(investigationStage?.detail), /agent recommended: NO_ACTION/);
});

test("70. an Investigation CREATE_WORK_ORDER recommendation is left unchanged", async () => {
  const { result, state } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 1);
  assert.equal(result.workflow?.investigation?.recommendedAction, "CREATE_WORK_ORDER");
  assert.equal(
    result.workflow?.agentRecommendedAction,
    undefined,
    "no override happened, so no historical recommendation is recorded"
  );
  assert.equal(result.workflow?.actionOverrideReason, undefined);
});

test("71. the explicit-request override does not weaken the grounding gate", async () => {
  const empty = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    {
      transcript: EXPLICIT_CREATE_TRANSCRIPT,
      retrieval: { docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" },
    }
  );

  assert.equal(empty.result.workflow?.status, "clarification_required", "no evidence still blocks");
  assert.equal(empty.state.writes, 0, "the override never bypasses grounding");
  assert.equal(empty.roleOf("action"), 0);

  const below = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    { transcript: EXPLICIT_CREATE_TRANSCRIPT, retrieval: scoreRetrieval(0.2) }
  );

  assert.equal(below.result.workflow?.status, "clarification_required", "sub-threshold evidence still blocks");
  assert.equal(below.state.writes, 0);
  assert.equal(below.roleOf("action"), 0);
});

test("72. the explicit-request override does not weaken the asset guards", async () => {
  const mismatched = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
    { transcript: EXPLICIT_CREATE_TRANSCRIPT, triage: { assetId: "M-103" } }
  );

  assert.equal(mismatched.result.workflow?.status, "clarification_required");
  assert.equal(mismatched.state.writes, 0, "a disagreeing asset never reaches the database");

  const unresolved = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
    {
      transcript: "Please create a new work order; the unit is making abnormal vibration.",
      triage: { assetId: null },
    }
  );

  assert.equal(unresolved.result.workflow?.status, "clarification_required", "no asset reference still clarifies");
  assert.equal(unresolved.state.writes, 0);
});

test("73. CHECK_STATUS and REQUEST_INFORMATION never mutate, even with an explicit create verb", async () => {
  for (const intent of ["CHECK_STATUS", "REQUEST_INFORMATION"] as const) {
    const { result, state, roleOf } = await runGroundedWorkflow(
      { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
      { transcript: EXPLICIT_CREATE_TRANSCRIPT, triage: { intent } }
    );

    assert.equal(result.workflow?.status, "completed", `${intent} still completes`);
    assert.equal(state.writes, 0, `${intent} never mutates on an explicit create verb`);
    assert.equal(result.workflow?.actionRequest, null);
    assert.equal(roleOf("action"), 0, `${intent} never reaches the action stage`);
    assert.equal(
      result.workflow?.actionOverrideReason,
      undefined,
      `${intent} is not eligible for the override`
    );
  }
});

test("74. metadata.forceAction builds a deterministic work order when the action agent declines", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    {
      transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
      metadata: { forceAction: true },
      action: { type: "NO_ACTION", reason: "Nothing should be written." },
    }
  );

  assert.equal(roleOf("action"), 1, "the action agent is consulted, then overridden");
  assert.equal(state.writes, 1, "the forced request is written once");
  const request = result.workflow?.actionRequest;
  if (request?.type !== "CREATE_WORK_ORDER") throw new Error("expected a forced work order request");
  assert.equal(request.assetId, P204_ID, "the request targets the resolved asset id");
  assert.equal(request.priority, "MEDIUM", "priority derives from the triage severity default");
  assert.match(request.title, /Forced work order/);
  assert.match(request.reason, /forced by the application/);
  assert.equal(result.workflow?.agentRecommendedAction, "NO_ACTION");
  assert.equal(result.workflow?.actionOverrideReason, "forced");
  assert.equal(result.workflow?.action?.entity, "work_order");
});

test("75. forceAction cannot bypass grounding, asset mismatch, or NEEDS_CLARIFICATION", async () => {
  const ungrounded = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
    {
      transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
      metadata: { forceAction: true },
      retrieval: scoreRetrieval(0.2),
    }
  );
  assert.equal(ungrounded.result.workflow?.status, "clarification_required", "force never bypasses grounding");
  assert.equal(ungrounded.state.writes, 0);

  const mismatched = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
    {
      transcript: EXPLICIT_CREATE_TRANSCRIPT,
      metadata: { forceAction: true },
      triage: { assetId: "M-103" },
    }
  );
  assert.equal(mismatched.result.workflow?.status, "clarification_required", "force never bypasses the asset guard");
  assert.equal(mismatched.state.writes, 0);

  const clarifying = await runGroundedWorkflow(
    { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
    {
      transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
      metadata: { forceAction: true },
      action: { type: "NEEDS_CLARIFICATION", reason: "missing identifier", clarification: "Which unit?" },
    }
  );
  assert.equal(clarifying.result.workflow?.status, "clarification_required", "clarification still wins over force");
  assert.equal(clarifying.state.writes, 0);
  assert.match(String(clarifying.result.answer), /Which unit\?/);
});

test("76. forceAction does not make CHECK_STATUS or REQUEST_INFORMATION mutate", async () => {
  for (const intent of ["CHECK_STATUS", "REQUEST_INFORMATION"] as const) {
    const { result, state, roleOf } = await runGroundedWorkflow(
      { ...GROUNDED_INVESTIGATION, recommendedAction: "NO_ACTION" },
      { transcript: EXPLICIT_CREATE_TRANSCRIPT, triage: { intent }, metadata: { forceAction: true } }
    );

    assert.equal(state.writes, 0, `${intent} stays read-only under forceAction`);
    assert.equal(result.workflow?.actionRequest, null);
    assert.equal(roleOf("action"), 0);
  }
});

test("77. a supplied work-order code passes through the force path unchanged", async () => {
  const { result, state } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    {
      transcript: EXPLICIT_CREATE_TRANSCRIPT,
      metadata: { forceAction: true, workOrderCode: "CODE-2026-001" },
      action: { type: "NO_ACTION", reason: "Nothing should be written." },
    }
  );

  assert.equal(state.writes, 1);
  assert.equal(result.workflow?.action?.code, "CODE-2026-001", "the supplied code reaches the database unchanged");
  assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");
  assert.equal(result.workflow?.status, "completed");
  assert.equal(result.workflow?.verification?.success, true, "the forced write is still read back");
});

test("78. forceAction originates only from metadata, never from an agent response", async () => {
  // The Investigation agent cannot grant itself permission. The strict investigation
  // schema is the first line of defence: a `forceAction` key in an agent response is
  // rejected outright rather than silently ignored, because a model must not be able
  // to widen the accepted response shape to enable a write.
  const { result, state, roleOf } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004"],
    },
    { transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection." }
  );

  assert.equal(state.writes, 0, "no write happens without the metadata flag");
  assert.equal(roleOf("action"), 0, "the action stage is not reached without the metadata flag");
  assert.equal(result.workflow?.actionOverrideReason, undefined);
  assert.equal(result.workflow?.agentRecommendedAction, undefined);
  assert.match(String(result.answer), /No database change was made/);

  // And with the flag absent, an agent that *claims* to be forcing gets a 502 rather
  // than a write: the parser rejects the unknown key.
  assert.throws(
    () =>
      parseInvestigationResult({
        findings: ["Vibration observed."],
        recommendedAction: "NO_ACTION",
        rationale: "Nothing to do.",
        existingWorkOrderCodes: ["WO-2026-004"],
        forceAction: true,
      }),
    PipeError,
    "an agent response cannot introduce a force field"
  );
});

test("79. existing work order codes are reported as evidence, never as a veto", async () => {
  const { result, state } = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004", "WO-2026-007"],
    },
    { transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection." }
  );

  assert.equal(state.writes, 0, "a NO_ACTION recommendation with no explicit request still writes nothing");
  assert.deepEqual(result.workflow?.investigation?.existingWorkOrderCodes, ["WO-2026-004", "WO-2026-007"]);
  const actionStep = result.workflow?.trace.agents.find((agent) => agent.role === "action");
  assert.match(
    String(actionStep?.decision),
    /Action: NO_ACTION · no database change was made · existing work orders: WO-2026-004, WO-2026-007/,
    "the codes are reported alongside the no-op"
  );
  assert.match(String(result.answer), /No database change was made/);
});

test("80. the existingWorkOrderCodes field is optional on the wire and defaults to empty", () => {
  const withoutField = parseInvestigationResult({
    findings: ["Vibration observed."],
    recommendedAction: "NO_ACTION",
    rationale: "Not enough to act.",
  });
  assert.deepEqual(withoutField.existingWorkOrderCodes, [], "an omitted field parses to an empty list");

  const withField = parseInvestigationResult({
    findings: ["Vibration observed."],
    recommendedAction: "NO_ACTION",
    rationale: "Not enough to act.",
    existingWorkOrderCodes: ["WO-2026-004"],
  });
  assert.deepEqual(withField.existingWorkOrderCodes, ["WO-2026-004"]);

  assert.throws(
    () =>
      parseInvestigationResult({
        findings: ["Vibration observed."],
        recommendedAction: "NO_ACTION",
        rationale: "Not enough to act.",
        existingWorkOrderCodes: "WO-2026-004",
      }),
    PipeError,
    "a non-array value is rejected"
  );
});

/**
 * The exact envelope that failed the first live E2E run. It is a valid
 * CREATE_WORK_ORDER request except for `assetCode`, which the strict schema does
 * not define, so it is rejected by the production schema exactly as it was live.
 */
const MALFORMED_LIVE_ACTION_ENVELOPE: Record<string, unknown> = {
  type: "CREATE_WORK_ORDER",
  assetId: "P-204",
  assetCode: "P-204",
  title: "Test",
  description: "Test",
  reason: "Test",
  priority: "HIGH",
};

function caughtPipeError(run: () => unknown): PipeError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof PipeError, `expected a PipeError, received ${String(error)}`);
    return error;
  }
  assert.fail("expected the action boundary to throw");
}

test("81. malformed Lyzr Action output is lyzr_malformed/502 and never a 400 caller error", () => {
  const error = caughtPipeError(() => parseActionDecision(MALFORMED_LIVE_ACTION_ENVELOPE));

  assert.equal(error.kind, "lyzr_malformed", "an agent contract violation is a provider failure");
  assert.equal(error.status, 502, "the caller must not be told it sent a bad request");
  assert.notEqual(error.kind, "invalid_request");
  assert.match(error.message, /Unrecognized key/, "the Zod reason is preserved");
  assert.match(error.message, /assetCode/, "the offending field path is preserved");
});

test("82. caller-supplied action requests keep invalid_request/400", () => {
  const callerError = caughtPipeError(() => parseActionRequest(MALFORMED_LIVE_ACTION_ENVELOPE));
  assert.equal(callerError.kind, "invalid_request", "a caller payload is still a 400");
  assert.equal(callerError.status, 400);

  const agentError = caughtPipeError(() => parseActionDecision(MALFORMED_LIVE_ACTION_ENVELOPE));
  assert.equal(agentError.kind, "lyzr_malformed");
  assert.equal(agentError.status, 502);
  assert.equal(
    agentError.message,
    callerError.message,
    "re-classification preserves the validation message exactly"
  );
});

test("83. every action-schema rejection at the agent boundary is lyzr_malformed, not 400", () => {
  const rejections: unknown[] = [
    MALFORMED_LIVE_ACTION_ENVELOPE,
    { type: "CREATE_WORK_ORDER", assetId: "P-204", title: "T", description: "D", reason: "R", priority: "URGENT" },
    { type: "CREATE_WORK_ORDER", assetId: "P-204", title: "T", description: "D", reason: "R", priority: "HIGH", status: "SCHEDULED" },
    { type: "CREATE_WORK_ORDER", assetId: "P-204", title: "T", description: "D", reason: "R", priority: "HIGH", scheduledAt: "as soon as possible" },
    { type: "CREATE_WORK_ORDER", assetId: "P-204", title: "T", description: "D", priority: "HIGH" },
    { type: "CREATE_WORK_ORDER", title: "T", description: "D", reason: "R", priority: "HIGH" },
    { type: "NO_ACTION", reason: "ok", confidence: 0.8 },
    { type: "NO_ACTION", reason: "" },
    { type: "DELETE_EVERYTHING", reason: "nope" },
    { assetId: "P-204", title: "T", description: "D", reason: "R", priority: "HIGH" },
    { type: "CREATE_WORK_ORDER", actionType: "UPDATE_WORK_ORDER", assetId: "P-204", title: "T", description: "D", reason: "R", priority: "HIGH" },
  ];

  for (const payload of rejections) {
    const error = caughtPipeError(() => parseActionDecision(payload));
    assert.equal(error.kind, "lyzr_malformed", JSON.stringify(payload));
    assert.equal(error.status, 502, JSON.stringify(payload));
    assert.ok(error.message.length > 0, "the validation detail is always preserved");
  }
});

test("84. a rejected Action decision writes nothing and never reports a 400", async () => {
  const { result, state, persistCalls } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    action: MALFORMED_LIVE_ACTION_ENVELOPE,
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
  });

  assert.equal(state.writes, 0, "a rejected action decision performs no Prisma mutation");
  assert.equal(persistCalls(), 0, "no agent result is persisted when no action executed");
  assert.equal(result.workflow?.status, "failed");
  assert.equal(result.workflow?.errorKind, "lyzr_malformed", "the workflow reports the provider failure");
  assert.equal(result.workflow?.errorStatus, 502, "the route maps this to HTTP 502, not 400");
  assert.match(String(result.workflow?.error), /assetCode/, "the offending field survives into the result");
  assert.equal(result.workflow?.action, null, "no action entity is produced");
  assert.equal(result.workflow?.verification?.success, false);
});

test("85. the Action prompt asks for assetId and never instructs the agent to emit assetCode", async () => {
  const prompts: string[] = [];
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("/inference/chat/")) throw new Error(`unexpected request target ${url}`);
    const sent = JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string; message?: string };
    if (sent.agent_id === AGENT_IDS.action && typeof sent.message === "string") {
      prompts.push(sent.message);
    }
    return new Response(
      JSON.stringify({ response: JSON.stringify({ type: "NO_ACTION", reason: "Nothing to do." }) }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    await withLiveEnv(() =>
      runAction({
        input: {
          source: "web",
          transcript: EXPLICIT_CREATE_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: "phase6-action-prompt",
          metadata: {},
        },
        asset: null,
        triage: {
          intent: "REPORT_ISSUE",
          assetId: "P-204",
          plantId: null,
          issue: EXPLICIT_CREATE_TRANSCRIPT,
          severity: "HIGH",
          requiresInvestigation: true,
        },
        retrieval: sopRetrieval(),
        investigation: parseInvestigationResult(GROUNDED_INVESTIGATION),
        action: null,
        actionVerification: null,
      })
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(prompts.length, 1, "the Action prompt was captured from the live request body");
  const prompt = prompts[0];

  assert.match(prompt, /assetId/, "the prompt names the field the schema actually defines");
  assert.doesNotMatch(prompt, /Use assetCode/, "the directive that contradicted the strict schema is gone");

  const linesWithAssetCode = prompt.split("\n").filter((line) => line.includes("assetCode"));
  assert.ok(
    linesWithAssetCode.length > 0,
    "the prompt actively forbids assetCode, so the contract is stated rather than merely implied"
  );
  for (const line of linesWithAssetCode) {
    assert.match(
      line,
      /\b(?:never|not|do not|don't|no)\b/i,
      `assetCode may appear only in a prohibition, never as a field to use: ${line}`
    );
  }
});

/**
 * The Action agent names the asset it is acting on, including when it declines.
 * The strict decline schemas therefore declare an optional `assetId` rather
 * than silently dropping or aliasing it. `assetCode` is never an accepted key.
 */
const LIVE_DECLINE_WITH_ASSET_ID: Record<string, unknown> = {
  type: "NO_ACTION",
  reason: "Four open work orders already cover the reported vibration on P-204.",
  assetId: "P-204",
};

test("86. NO_ACTION accepts the optional assetId naming the asset it declined", async () => {
  const parsed = parseActionDecision(LIVE_DECLINE_WITH_ASSET_ID);

  assert.equal(parsed.type, "NO_ACTION");
  assert.equal(
    parsed.type === "NO_ACTION" ? parsed.assetId : undefined,
    "P-204",
    "the declared asset reference survives validation"
  );
  assert.equal(
    Object.hasOwn(parsed, "clarification"),
    false,
    "the schema still drops an optional null it owns; assetId is declared, not coerced"
  );

  const viaAlias = parseActionDecision({
    actionType: "NO_ACTION",
    reason: "Already covered by an open work order.",
    assetId: "P-204",
  });
  assert.equal(
    viaAlias.type === "NO_ACTION" ? viaAlias.assetId : undefined,
    "P-204",
    "the actionType alias is normalised before the decline schema runs"
  );

  const { state, persistCalls } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    action: LIVE_DECLINE_WITH_ASSET_ID,
  });

  assert.equal(state.writes, 0, "a decline carrying assetId performs no Prisma mutation");
  assert.equal(persistCalls(), 0, "and triggers no memory persistence");
});

test("87. NEEDS_CLARIFICATION accepts the optional assetId naming the asset in question", async () => {
  const decision = {
    type: "NEEDS_CLARIFICATION",
    reason: "The asset reference could not be resolved to a FieldOS record.",
    clarification: "Which unit on line 2 is affected?",
    assetId: "P-204",
  };

  const parsed = parseActionDecision(decision);

  assert.equal(parsed.type, "NEEDS_CLARIFICATION");
  assert.equal(
    parsed.type === "NEEDS_CLARIFICATION" ? parsed.assetId : undefined,
    "P-204"
  );
  assert.equal(
    parsed.type === "NEEDS_CLARIFICATION" ? parsed.clarification : undefined,
    "Which unit on line 2 is affected?"
  );

  const { state, persistCalls } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    action: decision,
  });

  assert.equal(state.writes, 0, "a clarification request is not a mutation");
  assert.equal(persistCalls(), 0, "and triggers no memory persistence");
});

test("88. accepting assetId leaves the decline schemas strict", () => {
  const assetCode = caughtPipeError(() =>
    parseActionDecision({
      type: "NO_ACTION",
      reason: "Already covered by an open work order.",
      assetCode: "P-204",
    })
  );

  assert.equal(assetCode.kind, "lyzr_malformed", "assetCode is still an unknown key");
  assert.equal(assetCode.status, 502, "and is still a provider failure, not a 400");
  assert.match(assetCode.message, /Unrecognized key: "assetCode"/);

  const clarificationAssetCode = caughtPipeError(() =>
    parseActionDecision({
      type: "NEEDS_CLARIFICATION",
      reason: "Ambiguous.",
      clarification: "Which unit?",
      assetCode: "P-204",
    })
  );

  assert.equal(clarificationAssetCode.kind, "lyzr_malformed");
  assert.equal(clarificationAssetCode.status, 502);
  assert.match(clarificationAssetCode.message, /Unrecognized key: "assetCode"/);

  for (const extra of ["confidence", "sql", "title", "priority", "status"]) {
    const error = caughtPipeError(() =>
      parseActionDecision({ type: "NO_ACTION", reason: "Declined.", [extra]: "x" })
    );
    assert.equal(error.kind, "lyzr_malformed", extra);
    assert.match(error.message, /Unrecognized key/, `${extra} is not a permitted field`);
  }

  assert.throws(
    () => parseActionDecision({ type: "NO_ACTION", reason: "Declined.", assetId: "   " }),
    rejectsWithAnyPipeError(),
    "the declared assetId keeps the shared identifier constraints"
  );
});

test("89. the exact run-002 payload now completes as a no-op instead of a 502", async () => {
  const { result, state, persistCalls } = await runGroundedWorkflow(GROUNDED_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    action: LIVE_DECLINE_WITH_ASSET_ID,
  });

  assert.equal(result.workflow?.status, "completed", "a decline is not a provider failure");
  assert.equal(result.workflow?.errorKind ?? null, null, "the 502 no longer occurs");
  assert.equal(result.workflow?.errorStatus ?? null, null);
  assert.equal(result.workflow?.error ?? null, null);
  assert.equal(
    result.workflow?.investigation?.recommendedAction,
    "CREATE_WORK_ORDER",
    "Model A's explicit-create override is untouched by the contract fix"
  );
  assert.equal(result.workflow?.action, null, "accepting assetId must not turn NO_ACTION into a write");
  assert.equal(result.workflow?.actionRequest, null, "no executable request is produced");
  assert.equal(result.workflow?.verification, null, "a declined action is never verified");
  assert.equal(state.writes, 0, "the run stays a zero-write no-op");
  assert.equal(persistCalls(), 0, "no agent result is persisted when no action executed");
});

const DECLINE_SCHEMA_FIELDS = ["reason", "clarification", "assetId"] as const;

const SAMPLE_FIELD_VALUE: Record<string, unknown> = {
  assetId: "P-204",
  workOrderId: "66ba3c8a-efa4-48cc-b413-1ca5327c2b17",
  workOrderCode: "WO-P204-1DEC5ED94E",
  incidentId: "INC-204-1",
  incidentCode: "INC-204",
  technicianId: "tech-7",
  title: "Bearing and alignment inspection",
  description: "Inspect the drive-end bearing and confirm shaft alignment.",
  rootCause: "Bearing wear is suspected but unconfirmed.",
  reason: "Reported abnormal vibration above the grounded threshold.",
  clarification: "Which unit on line 2 is affected?",
  actionTaken: "Locked out the unit pending inspection.",
  priority: "HIGH",
  severity: "HIGH",
  status: "OPEN",
  code: "WO-P204-PROBE",
  scheduledAt: "2026-09-30T08:00:00.000Z",
  completedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: "2026-09-29T08:00:00.000Z",
  resolvedAt: "2026-09-30T12:00:00.000Z",
  performedAt: "2026-09-30T09:00:00.000Z",
};

const MINIMAL_VALID_DECISION: Record<string, Record<string, unknown>> = {
  CREATE_WORK_ORDER: {
    type: "CREATE_WORK_ORDER",
    assetId: "P-204",
    title: "Bearing and alignment inspection",
    description: "Inspect the drive-end bearing and confirm shaft alignment.",
    reason: "Reported abnormal vibration above the grounded threshold.",
    priority: "HIGH",
  },
  UPDATE_WORK_ORDER: {
    type: "UPDATE_WORK_ORDER",
    reason: "Escalating the priority.",
    workOrderId: "66ba3c8a-efa4-48cc-b413-1ca5327c2b17",
    priority: "HIGH",
  },
  RECORD_OBSERVATION: {
    type: "RECORD_OBSERVATION",
    assetId: "P-204",
    title: "Vibration observation",
    description: "Bearing and alignment inspection for rising vibration.",
    reason: "Reported abnormal vibration above the grounded threshold.",
  },
  ESCALATE_INCIDENT: {
    type: "ESCALATE_INCIDENT",
    reason: "Recurring failure on a safety-critical unit.",
    severity: "CRITICAL",
    incidentId: "INC-204-1",
  },
  NO_ACTION: {
    type: "NO_ACTION",
    reason: "Already covered by an open work order.",
  },
  NEEDS_CLARIFICATION: {
    type: "NEEDS_CLARIFICATION",
    reason: "The asset reference could not be resolved.",
    clarification: "Which unit on line 2 is affected?",
  },
  CREATE_INCIDENT: {
    type: "CREATE_INCIDENT",
    assetId: "P-204",
    title: "Bearing failure",
    description: "Bearing and alignment inspection for rising vibration.",
    rootCause: "Bearing wear is suspected but unconfirmed.",
    reason: "Reported abnormal vibration above the grounded threshold.",
    severity: "HIGH",
  },
};

async function captureActionPrompt(): Promise<string> {
  const previousFetch = globalThis.fetch;
  const prompts: string[] = [];

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("/inference/chat/")) throw new Error(`unexpected request target ${url}`);
    const sent = JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string; message?: string };
    if (sent.agent_id === AGENT_IDS.action && typeof sent.message === "string") {
      prompts.push(sent.message);
    }
    return new Response(
      JSON.stringify({ response: JSON.stringify({ type: "NO_ACTION", reason: "Nothing to do." }) }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    await withLiveEnv(() =>
      runAction({
        input: {
          source: "web",
          transcript: EXPLICIT_CREATE_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: "phase6-action-prompt-contract",
          metadata: {},
        },
        asset: null,
        triage: {
          intent: "REPORT_ISSUE",
          assetId: "P-204",
          plantId: null,
          issue: EXPLICIT_CREATE_TRANSCRIPT,
          severity: "HIGH",
          requiresInvestigation: true,
        },
        retrieval: sopRetrieval(),
        investigation: parseInvestigationResult(GROUNDED_INVESTIGATION),
        action: null,
        actionVerification: null,
      })
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(prompts.length, 1, "exactly one Action prompt was captured");
  return prompts[0];
}

test("90. every field the Action prompt permits is accepted by that type's strict schema", async () => {
  const prompt = await captureActionPrompt();

  const allowedLine = prompt
    .split("\n")
    .find((line) => line.startsWith("Allowed types:"));
  assert.ok(allowedLine, "the prompt still states the allowed action types");
  const allowedTypes = new Set(
    allowedLine
      .replace("Allowed types:", "")
      .split(",")
      .map((token) => token.trim().split(" ")[0])
      .filter((token) => /^[A-Z_]+$/.test(token))
  );

  const declared = new Map<string, string[]>();
  // The instruction block precedes the injected context, so a `LABEL: value` line
  // in the data block (TRANSCRIPT, TRIAGE, ...) is not a field-list declaration.
  const instructionBlock = prompt.split("\n").slice(0, prompt.split("\n").findIndex((line) => line.startsWith("TRANSCRIPT:")));
  assert.ok(instructionBlock.length > 0, "the prompt has an instruction block before the context");
  for (const line of instructionBlock) {
    const match = /^([A-Z_]+): (.+)$/.exec(line.trim());
    if (!match) continue;
    const [, type, list] = match;
    declared.set(
      type,
      list
        .split(",")
        .map((token) => token.trim().replace(/^\*/, ""))
        .filter((token) => /^[a-zA-Z][a-zA-Z0-9]*$/.test(token))
    );
  }

  assert.ok(declared.size > 0, "the prompt declares per-type field lists");
  for (const type of allowedTypes) {
    assert.ok(declared.has(type), `the prompt states the exact fields for the allowed type ${type}`);
  }
  for (const type of declared.keys()) {
    assert.ok(
      MINIMAL_VALID_DECISION[type] !== undefined,
      `the prompt documents ${type}, which is not an action type any schema defines`
    );
  }

  for (const [type, fields] of declared) {
    const base = MINIMAL_VALID_DECISION[type];
    assert.equal(
      parseActionDecision(base).type,
      type,
      `the ${type} baseline used to probe its declared fields is itself valid`
    );

    for (const field of fields) {
      const sample = SAMPLE_FIELD_VALUE[field];
      assert.notEqual(
        sample,
        undefined,
        `the prompt declares ${type}.${field} but the probe has no sample value for it`
      );

      let message = "";
      let parsed: unknown;
      try {
        parsed = parseActionDecision({ ...base, [field]: sample });
      } catch (error) {
        message = error instanceof PipeError ? error.message : String(error);
      }

      assert.doesNotMatch(
        message,
        /Unrecognized key/,
        `the prompt tells the agent ${type} may emit "${field}", but the strict schema rejects it as an unknown key`
      );
      if (parsed !== undefined) {
        assert.ok(
          Object.hasOwn(parsed as object, field),
          `${type}.${field} is declared by the prompt but dropped by the schema`
        );
      }
    }
  }

  const declineTypes = new Set(
    [...declared.entries()]
      .filter(([, fields]) => fields.includes("assetId") && fields.includes("reason"))
      .map(([type]) => type)
  );
  for (const type of ["NO_ACTION", "NEEDS_CLARIFICATION"]) {
    assert.ok(declineTypes.has(type), `${type} must still be described as accepting an optional assetId`);
    for (const field of DECLINE_SCHEMA_FIELDS) {
      assert.ok(declared.get(type)?.includes(field), `${type} must document ${field}`);
    }
  }

  assert.ok(
    !(declared.get("ESCALATE_INCIDENT") ?? []).includes("assetId"),
    "ESCALATE_INCIDENT must not be described as accepting assetId, which its schema rejects"
  );
});

// ---------------------------------------------------------------------------
// Option C: an explicit, deterministic, grounded create request is authorised
// by application policy, so the action agent's NO_ACTION stops vetoing it.
// NEEDS_CLARIFICATION and every deterministic guard stay authoritative.
// ---------------------------------------------------------------------------

const EXPLICIT_NO_ACTION_INVESTIGATION = {
  ...GROUNDED_INVESTIGATION,
  recommendedAction: "NO_ACTION",
  existingWorkOrderCodes: ["WO-2026-004"],
};

const NO_EXPLICIT_CREATE_TRANSCRIPT =
  "P-204. The pump is making abnormal vibration and needs a follow-up inspection.";

test("91. an explicit create request is still completed when the action agent returns CREATE_WORK_ORDER", async () => {
  const { result, state } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
  });

  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 1, "the agent's own request is written exactly once");
  const request = result.workflow?.actionRequest;
  if (request?.type !== "CREATE_WORK_ORDER") throw new Error("expected a created work order request");
  assert.match(
    request.title,
    /^Inspect intake filter/,
    "the agent-authored request is used, not a deterministically rebuilt one"
  );
  assert.equal(result.workflow?.action?.entity, "work_order");
});

test("92. an explicit grounded create request survives an action-agent NO_ACTION", async () => {
  const { result, state, roleOf } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });

  assert.equal(roleOf("action"), 1, "the action agent is consulted, then overridden");
  assert.equal(result.workflow?.status, "completed");
  assert.equal(state.writes, 1, "the declined explicit request is created exactly once");
  const request = result.workflow?.actionRequest;
  if (request?.type !== "CREATE_WORK_ORDER") throw new Error("expected a substituted work order request");
  assert.equal(request.assetId, P204_ID, "the substituted request targets the resolved asset id");
  assert.match(request.title, /^Requested work order/, "the explicit path is labelled, not the force path");
  assert.doesNotMatch(request.title, /Forced work order/, "the explicit path never claims to be a forced write");
  assert.match(request.reason, /explicit user request/i);
  assert.doesNotMatch(request.reason, /forced by the application/i);
  assert.match(request.reason, /WO-2026-004/, "the overlapping work orders stay in the record as evidence");
  assert.equal(
    result.workflow?.agentRecommendedAction,
    "NO_ACTION",
    "the agent's own NO_ACTION is preserved for the record"
  );
  assert.equal(result.workflow?.actionOverrideReason, "explicit_request");
  assert.equal(result.workflow?.action?.entity, "work_order", "the work order really was created");
  assert.equal(result.workflow?.action?.assetCode, "P-204");
});

test("93. NEEDS_CLARIFICATION always wins over an explicit create request", async () => {
  const { result, state } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    action: {
      type: "NEEDS_CLARIFICATION",
      reason: "The reported unit is ambiguous.",
      clarification: "Which unit is vibrating, intake filter or discharge pump?",
    },
  });

  assert.equal(result.workflow?.status, "clarification_required", "clarification is never substituted");
  assert.equal(state.writes, 0, "a clarification never writes");
  assert.equal(result.workflow?.actionRequest, null);
  assert.match(String(result.answer), /Which unit is vibrating/);
});

test("94. an explicit create request still requires grounded evidence", async () => {
  const ungrounded = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    retrieval: { docs: [], latencyMs: 1, collectionName: "fieldos-knowledge", query: "q" },
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });

  assert.equal(ungrounded.result.workflow?.status, "clarification_required", "no evidence still blocks");
  assert.equal(ungrounded.state.writes, 0);
  assert.equal(
    ungrounded.roleOf("action"),
    0,
    "grounding is checked before the action agent is even consulted"
  );

  const below = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    retrieval: scoreRetrieval(0.2),
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });

  assert.equal(below.result.workflow?.status, "clarification_required", "sub-threshold evidence still blocks");
  assert.equal(below.state.writes, 0);
  assert.equal(below.roleOf("action"), 0);
});

test("95. an explicit create request still respects the asset guards", async () => {
  const mismatched = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    triage: { assetId: "M-103" },
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });

  assert.equal(mismatched.result.workflow?.status, "clarification_required", "a disagreeing asset still clarifies");
  assert.equal(mismatched.state.writes, 0, "a disagreeing asset never reaches the database");

  const unresolved = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: "Please create a new work order; the unit is making abnormal vibration.",
    triage: { assetId: null },
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });

  assert.equal(unresolved.result.workflow?.status, "clarification_required", "an unresolved asset still clarifies");
  assert.equal(unresolved.state.writes, 0);
});

test("96. CHECK_STATUS and REQUEST_INFORMATION never mutate, even against an action NO_ACTION", async () => {
  for (const intent of ["CHECK_STATUS", "REQUEST_INFORMATION"] as const) {
    const { result, state, roleOf } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
      transcript: EXPLICIT_CREATE_TRANSCRIPT,
      triage: { intent },
      action: { type: "NO_ACTION", reason: "Nothing should be written." },
    });

    assert.equal(state.writes, 0, `${intent} never mutates when the action agent declines`);
    assert.equal(result.workflow?.actionRequest, null);
    assert.equal(roleOf("action"), 0, `${intent} never reaches the action stage`);
    assert.equal(
      result.workflow?.actionOverrideReason,
      undefined,
      `${intent} is never eligible for the explicit-create authorisation`
    );
  }
});

test("97. forceAction still builds a forced work order, labelled distinctly", async () => {
  const { result, state } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: NO_EXPLICIT_CREATE_TRANSCRIPT,
    metadata: { forceAction: true },
    action: { type: "NO_ACTION", reason: "Nothing should be written." },
  });

  assert.equal(state.writes, 1, "the forced request is written exactly once");
  const request = result.workflow?.actionRequest;
  if (request?.type !== "CREATE_WORK_ORDER") throw new Error("expected a forced work order request");
  assert.match(request.title, /^Forced work order/, "the force path keeps its own label");
  assert.doesNotMatch(request.title, /Requested work order/, "the force path never claims a user request");
  assert.match(request.reason, /forced by the application/);
  assert.equal(result.workflow?.actionOverrideReason, "forced");
});

test("98. an explicit create request never rewrites another action class", async () => {
  const { result, state } = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    action: {
      type: "UPDATE_WORK_ORDER",
      workOrderCode: "WO-2026-004",
      reason: "Raise the priority of the existing work order instead of duplicating it.",
      priority: "CRITICAL",
    },
  });

  assert.equal(state.writes, 1);
  assert.equal(
    result.workflow?.actionRequest?.type,
    "UPDATE_WORK_ORDER",
    "the explicit-create substitution only replaces NO_ACTION, never another action class"
  );
  assert.equal(result.workflow?.action?.entity, "work_order");
  assert.equal(
    result.workflow?.actionRequest?.priority,
    "CRITICAL",
    "the agent's own fields survive intact"
  );
  // The reason records the *investigation* recommendation being overridden, which
  // happens before the action agent is consulted. It does not mean the action
  // agent's own action class was substituted.
  assert.equal(
    result.workflow?.actionOverrideReason,
    "explicit_request",
    "the investigation override is still recorded for the record"
  );
});

test("99. the trace separates an explicit user request from an application force", async () => {
  const explicit = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: EXPLICIT_CREATE_TRANSCRIPT,
    action: { type: "NO_ACTION", reason: "An open work order already covers this asset." },
  });
  const forced = await runGroundedWorkflow(EXPLICIT_NO_ACTION_INVESTIGATION, {
    transcript: NO_EXPLICIT_CREATE_TRANSCRIPT,
    metadata: { forceAction: true },
    action: { type: "NO_ACTION", reason: "Nothing should be written." },
  });

  const traceOf = (result: { workflow?: { trace: { agents: { role: string; decision: string | null }[] } } }) =>
    String(result.workflow?.trace.agents.find((agent) => agent.role === "action")?.decision ?? "");

  assert.match(
    traceOf(explicit.result),
    /Action: CREATE_WORK_ORDER .*overridden by an explicit user request \(agent recommended NO_ACTION\)/,
    "the explicit substitution is visible and attributed to the user"
  );
  assert.match(
    traceOf(forced.result),
    /Action: CREATE_WORK_ORDER .*overridden by application policy \(agent recommended NO_ACTION\)/,
    "the application force is visible and not mistaken for a user request"
  );
  assert.doesNotMatch(
    traceOf(forced.result),
    /explicit user request/,
    "a forced write is never reported as a user request"
  );

  for (const run of [explicit, forced]) {
    const investigationStep = run.result.workflow?.trace.agents.find((agent) => agent.role === "investigation");
    assert.match(
      String(investigationStep?.decision),
      /agent recommended: NO_ACTION/,
      "the agent's own recommendation is always shown alongside the override"
    );
  }
});

test("100. the existing work-order list is evidence, never a veto", async () => {
  const overlapping = await runGroundedWorkflow(
    {
      ...GROUNDED_INVESTIGATION,
      recommendedAction: "NO_ACTION",
      existingWorkOrderCodes: ["WO-2026-004", "WO-2026-005", "WO-2026-006"],
    },
    {
      transcript: EXPLICIT_CREATE_TRANSCRIPT,
      action: { type: "NO_ACTION", reason: "Three open work orders already cover this asset." },
    }
  );

  assert.equal(overlapping.state.writes, 1, "a large overlap list does not block an explicit request");
  assert.deepEqual(
    overlapping.result.workflow?.investigation?.existingWorkOrderCodes,
    ["WO-2026-004", "WO-2026-005", "WO-2026-006"],
    "the evidence is preserved in the result"
  );
  assert.match(
    String(overlapping.result.workflow?.actionRequest?.reason),
    /WO-2026-004, WO-2026-005, WO-2026-006/,
    "every overlapping work order is recorded on the created request"
  );
});

test("101. the action prompt states the same policy the orchestrator applies", async () => {
  const prompts: string[] = [];
  const previousFetch = globalThis.fetch;

  globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
    const url = typeof input === "string" ? input : String(input);
    if (!url.includes("/inference/chat/")) throw new Error(`unexpected request target ${url}`);
    const sent = JSON.parse(String(init?.body ?? "{}")) as { agent_id?: string; message?: string };
    if (sent.agent_id === AGENT_IDS.action && typeof sent.message === "string") {
      prompts.push(sent.message);
    }
    return new Response(
      JSON.stringify({ response: JSON.stringify({ type: "NO_ACTION", reason: "Nothing to do." }) }),
      { status: 200 }
    );
  }) as typeof fetch;

  try {
    await withLiveEnv(() =>
      runAction({
        input: {
          source: "web",
          transcript: EXPLICIT_CREATE_TRANSCRIPT,
          timestamp: NOW.toISOString(),
          sessionId: "phase6-option-c-prompt",
          metadata: {},
        },
        asset: null,
        triage: {
          intent: "REPORT_ISSUE",
          assetId: "P-204",
          plantId: null,
          issue: EXPLICIT_CREATE_TRANSCRIPT,
          severity: "HIGH",
          requiresInvestigation: true,
        },
        retrieval: sopRetrieval(),
        investigation: parseInvestigationResult(GROUNDED_INVESTIGATION),
        action: null,
        actionVerification: null,
      })
    );
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(prompts.length, 1, "the Action prompt was captured from the live request body");
  const prompt = prompts[0];
  assert.match(
    prompt,
    /existing open work orders are evidence, not an automatic veto of an explicit user request/i,
    "the prompt must not instruct the agent to decline an explicit request as a duplicate"
  );
  assert.match(
    prompt,
    /backend action guards are applied after you answer/i,
    "the prompt must defer to the deterministic backend rather than claim the last word"
  );
  assert.match(
    prompt,
    /Do not return NO_ACTION merely to avoid a duplicate/i,
    "the prompt must name the exact decision the backend now overrides"
  );
  assert.match(
    prompt,
    /Never emit an assetCode field/,
    "the existing strict assetId-only contract is preserved"
  );
});
