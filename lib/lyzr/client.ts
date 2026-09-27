import { PipeError } from "../types";

const DEFAULT_BASE_URL = "https://agent-prod.studio.lyzr.ai/v3";
const DEFAULT_PROVIDER: LyzrProvider = "mock";
const PLACEHOLDERS = new Set([
  "",
  "...",
  "xxx",
  "undefined",
  "your-api-key",
  "your-base-url",
  "your-user-id",
  "your-session-id",
  "your-agent-id",
  "<api-key>",
]);

const ROLE_ENV: Record<LyzrRole, string> = {
  triage: "LYZR_TRIAGE_AGENT_ID",
  investigation: "LYZR_INVESTIGATION_AGENT_ID",
  action: "LYZR_ACTION_AGENT_ID",
  verification: "LYZR_VERIFICATION_AGENT_ID",
};

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RETRIES = 2;
const TIMEOUT_MAX_RETRIES = 1;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 5_000;

export type LyzrProvider = "lyzr" | "mock";
export type LyzrRole = "triage" | "investigation" | "action" | "verification";

export type LyzrFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LyzrChatOptions {
  fetchImpl?: LyzrFetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface LyzrAgentDefinition {
  name: string;
  description?: string;
  agent_role?: string;
  agent_instructions?: string;
  agent_goal?: string;
  agent_context?: string;
  agent_output?: string;
  examples?: string;
  features?: string[];
  tools?: string[];
  tool_usage_description?: string;
  llm_credential_id?: string;
  response_format?: Record<string, unknown>;
  provider_id?: string;
  model?: string;
  top_p?: number;
  temperature?: number;
  store_messages?: boolean;
  file_output?: boolean;
  max_iterations?: number;
  [key: string]: unknown;
}

export interface LyzrChatInput {
  role: LyzrRole;
  message: string;
  userId?: string;
  sessionId?: string;
  systemPromptVariables?: Readonly<Record<string, unknown>>;
  filterVariables?: Readonly<Record<string, unknown>>;
  features?: ReadonlyArray<Record<string, unknown>>;
}

export interface LyzrChatResult {
  content: string;
  provider: LyzrProvider;
  agentId: string;
  sessionId: string;
  latencyMs: number;
  mock: boolean;
}

export interface LyzrCreateResult {
  agentId: string;
  provider: LyzrProvider;
  latencyMs: number;
  mock: boolean;
}

export interface LyzrConfig {
  provider: LyzrProvider;
  baseUrl: string;
  apiKey?: string;
  userId?: string;
  sessionId?: string;
  agentIds: Record<LyzrRole, string>;
  timeoutMs: number;
  maxRetries: number;
}

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function readEnvInteger(name: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(readEnv(name), 10);
  if (!Number.isFinite(parsed) || parsed < minimum) return fallback;
  return parsed;
}

function hasValue(value: string): boolean {
  return !PLACEHOLDERS.has(value.toLowerCase());
}

function configError(message: string): PipeError {
  return new PipeError("lyzr_config", 503, message);
}

function requestError(message: string): PipeError {
  return new PipeError("lyzr_request", 502, message);
}

function malformedError(message: string): PipeError {
  return new PipeError("lyzr_malformed", 502, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw configError("LYZR_API_BASE_URL must be a valid HTTP or HTTPS URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw configError("LYZR_API_BASE_URL must use HTTP or HTTPS.");
  }

  return value.replace(/\/+$/, "");
}

export function getLyzrConfig(): LyzrConfig {
  const providerValue = readEnv("LYZR_PROVIDER") || DEFAULT_PROVIDER;
  if (providerValue !== "mock" && providerValue !== "lyzr") {
    throw configError("LYZR_PROVIDER must be either mock or lyzr.");
  }

  const baseUrl = normalizeBaseUrl(readEnv("LYZR_API_BASE_URL") || DEFAULT_BASE_URL);
  const apiKeyValue = readEnv("LYZR_API_KEY");
  const userIdValue = readEnv("LYZR_USER_ID");
  const sessionIdValue = readEnv("LYZR_SESSION_ID");
  const agentIds: Record<LyzrRole, string> = {
    triage: readEnv(ROLE_ENV.triage),
    investigation: readEnv(ROLE_ENV.investigation),
    action: readEnv(ROLE_ENV.action),
    verification: readEnv(ROLE_ENV.verification),
  };

  const apiKey = hasValue(apiKeyValue) ? apiKeyValue : undefined;
  if (providerValue === "lyzr" && !apiKey) {
    throw configError("Lyzr is not configured. Set LYZR_API_KEY or use LYZR_PROVIDER=mock.");
  }

  return {
    provider: providerValue,
    baseUrl,
    apiKey,
    userId: hasValue(userIdValue) ? userIdValue : undefined,
    sessionId: hasValue(sessionIdValue) ? sessionIdValue : undefined,
    agentIds: {
      triage: hasValue(agentIds.triage) ? agentIds.triage : "",
      investigation: hasValue(agentIds.investigation) ? agentIds.investigation : "",
      action: hasValue(agentIds.action) ? agentIds.action : "",
      verification: hasValue(agentIds.verification) ? agentIds.verification : "",
    },
    timeoutMs: readEnvInteger("LYZR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1),
    maxRetries: readEnvInteger("LYZR_MAX_RETRIES", DEFAULT_MAX_RETRIES, 0),
  };
}

export function lyzrConfigured(): boolean {
  try {
    getLyzrConfig();
    return true;
  } catch {
    return false;
  }
}

function getAgentId(config: LyzrConfig, role: LyzrRole): string {
  const agentId = config.agentIds[role];
  if (!agentId) {
    throw configError(`Lyzr agent for role ${role} is not configured.`);
  }
  return agentId;
}

function getRequestIdentity(input: LyzrChatInput, config: LyzrConfig): {
  userId: string;
  sessionId: string;
} {
  const userId = input.userId?.trim() || config.userId;
  const sessionId = input.sessionId?.trim() || config.sessionId;
  if (!userId) throw configError("Lyzr user identity is not configured. Set LYZR_USER_ID.");
  if (!sessionId) throw configError("Lyzr session identity is not configured. Set LYZR_SESSION_ID.");
  return { userId, sessionId: `${sessionId}::${input.role}` };
}

type LyzrAttemptResult =
  | { ok: true; content: string }
  | {
      ok: false;
      error: PipeError;
      retryable: boolean;
      timedOut: boolean;
      retryAfterMs: number | null;
    };

function isAbortLike(caught: unknown): boolean {
  if (!(caught instanceof Error)) return false;
  return caught.name === "AbortError" || caught.name === "TimeoutError";
}

function discardBody(response: Response): void {
  try {
    if (response.body) void response.body.cancel();
  } catch {
    return;
  }
}

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers?.get?.("retry-after")?.trim();
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_MAX_DELAY_MS);
  }
  const target = Date.parse(header);
  if (Number.isFinite(target)) {
    return Math.min(Math.max(target - Date.now(), 0), RETRY_MAX_DELAY_MS);
  }
  return null;
}

function backoffMs(attempt: number): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(exponential + jitter, RETRY_MAX_DELAY_MS);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestOnce(
  url: string,
  payload: string,
  apiKey: string,
  timeoutMs: number,
  fetchImpl: LyzrFetch
): Promise<LyzrAttemptResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: payload,
      signal: controller.signal,
    });
  } catch (caught) {
    if (isAbortLike(caught) || controller.signal.aborted) {
      return {
        ok: false,
        error: requestError("Lyzr request timed out."),
        retryable: true,
        timedOut: true,
        retryAfterMs: null,
      };
    }
    return {
      ok: false,
      error: requestError("Lyzr provider is unreachable."),
      retryable: true,
      timedOut: false,
      retryAfterMs: null,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    discardBody(response);
    return {
      ok: false,
      error: configError("Lyzr rejected the configured API key."),
      retryable: false,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  if (response.status === 404) {
    discardBody(response);
    return {
      ok: false,
      error: configError("The configured Lyzr agent could not be found."),
      retryable: false,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response);
    discardBody(response);
    return {
      ok: false,
      error: requestError("Lyzr rate limit reached."),
      retryable: true,
      timedOut: false,
      retryAfterMs,
    };
  }

  if (response.status >= 500) {
    discardBody(response);
    return {
      ok: false,
      error: requestError(`Lyzr request failed with status ${response.status}.`),
      retryable: true,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  if (!response.ok) {
    discardBody(response);
    return {
      ok: false,
      error: requestError(`Lyzr request failed with status ${response.status}.`),
      retryable: false,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return {
      ok: false,
      error: malformedError("Lyzr returned an unparsable response."),
      retryable: false,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  const content = isRecord(data) && typeof data.response === "string" ? data.response.trim() : "";
  if (!content) {
    return {
      ok: false,
      error: malformedError("Lyzr returned an empty or malformed response."),
      retryable: false,
      timedOut: false,
      retryAfterMs: null,
    };
  }

  return { ok: true, content };
}

function mockIdentifier(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "agent";
}

function mockChat(input: LyzrChatInput, config: LyzrConfig): LyzrChatResult {
  const sessionId = input.sessionId?.trim() || config.sessionId || "mock-session";
  const agentId = config.agentIds[input.role] || `mock-${input.role}`;
  return {
    content: `[MOCK LYZR] ${input.role} agent received: ${input.message}`,
    provider: "mock",
    agentId,
    sessionId,
    latencyMs: 0,
    mock: true,
  };
}

export async function chatWithLyzr(
  input: LyzrChatInput,
  options: LyzrChatOptions = {}
): Promise<LyzrChatResult> {
  const message = input.message.trim();
  if (!message) {
    throw new PipeError("invalid_request", 400, "Lyzr message must be a non-empty string.");
  }

  const config = getLyzrConfig();
  if (config.provider === "mock") return mockChat({ ...input, message }, config);

  const { userId, sessionId } = getRequestIdentity(input, config);
  const agentId = getAgentId(config, input.role);
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = performance.now();
  const body = {
    user_id: userId,
    agent_id: agentId,
    session_id: sessionId,
    message,
    ...(input.systemPromptVariables ? { system_prompt_variables: input.systemPromptVariables } : {}),
    ...(input.filterVariables ? { filter_variables: input.filterVariables } : {}),
    ...(input.features ? { features: input.features } : {}),
  };
  const url = `${config.baseUrl}/inference/chat/`;
  const payload = JSON.stringify(body);

  let content = "";
  let timeoutRetries = 0;
  for (let attempt = 0; ; attempt += 1) {
    const outcome = await requestOnce(url, payload, config.apiKey ?? "", config.timeoutMs, fetchImpl);
    if (outcome.ok) {
      content = outcome.content;
      break;
    }
    if (!outcome.retryable || attempt >= config.maxRetries) throw outcome.error;
    if (outcome.timedOut) {
      if (timeoutRetries >= TIMEOUT_MAX_RETRIES) throw outcome.error;
      timeoutRetries += 1;
    }
    await sleep(outcome.retryAfterMs ?? backoffMs(attempt));
  }

  return {
    content,
    provider: "lyzr",
    agentId,
    sessionId,
    latencyMs: Math.round(performance.now() - startedAt),
    mock: false,
  };
}

export async function createLyzrAgent(
  definition: LyzrAgentDefinition,
  role: LyzrRole = "investigation"
): Promise<LyzrCreateResult> {
  const name = definition.name.trim();
  if (!name) {
    throw new PipeError("invalid_request", 400, "Lyzr agent definition requires a name.");
  }

  const config = getLyzrConfig();
  if (config.provider === "mock") {
    return {
      agentId: `mock-${role}-${mockIdentifier(name)}`,
      provider: "mock",
      latencyMs: 0,
      mock: true,
    };
  }

  const startedAt = performance.now();
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}/agents/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey ?? "",
      },
      body: JSON.stringify({ ...definition, name }),
    });
  } catch {
    throw requestError("Lyzr provider is unreachable while creating the agent.");
  }

  if (response.status === 401 || response.status === 403) {
    throw configError("Lyzr rejected the configured API key.");
  }
  if (!response.ok) {
    throw requestError(`Lyzr agent creation failed with status ${response.status}.`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw malformedError("Lyzr returned an unparsable agent creation response.");
  }

  const agentId = isRecord(data) && typeof data.agent_id === "string" ? data.agent_id.trim() : "";
  if (!agentId) {
    throw malformedError("Lyzr did not return an agent ID.");
  }

  return {
    agentId,
    provider: "lyzr",
    latencyMs: Math.round(performance.now() - startedAt),
    mock: false,
  };
}
