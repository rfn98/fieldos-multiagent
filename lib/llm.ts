import { PipeError } from "./types";

const BASE_URL = (process.env.OLLAMA_BASE_URL ?? "https://ollama.com").replace(/\/+$/, "");
const API_KEY = process.env.OLLAMA_API_KEY?.trim() ?? "";
const MODEL = process.env.OLLAMA_MODEL?.trim() ?? "";

export function llmConfigured(): boolean {
  return BASE_URL.length > 0 && MODEL.length > 0;
}

export interface LlmCompleteParams {
  system: string;
  user: string;
}

export interface LlmCompleteResult {
  content: string;
  model: string;
  latencyMs: number;
}

export async function completeChat(params: LlmCompleteParams): Promise<LlmCompleteResult> {
  if (!llmConfigured()) {
    throw new PipeError(
      "llm_config",
      503,
      "LLM is not configured. Set OLLAMA_* (OLLAMA_BASE_URL / OLLAMA_API_KEY / OLLAMA_MODEL)."
    );
  }

  const startedAt = performance.now();

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: params.system },
          { role: "user", content: params.user },
        ],
        stream: false,
        options: {
          temperature: 0.1,
          num_predict: 250,
        },
      }),
    });
  } catch {
    throw new PipeError("llm_request", 502, "LLM provider is unreachable.");
  }

  const latencyMs = Math.round(performance.now() - startedAt);

  if (res.status === 401 || res.status === 403) {
    throw new PipeError("llm_config", 503, "LLM provider rejected the configured credentials.");
  }
  if (res.status === 404) {
    throw new PipeError("llm_config", 503, `LLM model "${MODEL}" was not found on the provider.`);
  }
  if (!res.ok) {
    throw new PipeError("llm_request", 502, `LLM provider request failed (status ${res.status}).`);
  }

  let data: { model?: unknown; message?: { content?: unknown } };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new PipeError("llm_malformed", 502, "LLM provider returned an unparsable response.");
  }

  const content = data.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new PipeError("llm_malformed", 502, "LLM provider returned an empty or malformed response.");
  }

  return {
    content: content.trim(),
    model: typeof data.model === "string" && data.model.length > 0 ? data.model : MODEL,
    latencyMs,
  };
}