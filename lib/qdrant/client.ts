import { QdrantClient } from "@qdrant/js-client-rest";
import { PipeError } from "../types";

const PLACEHOLDERS = new Set([
  "",
  "...",
  "xxx",
  "your-qdrant-url",
  "your-qdrant-api-key",
  "your-collection",
]);

const DEFAULT_COLLECTION = "fieldos-knowledge";
const DEFAULT_TIMEOUT_MS = 10_000;

function readEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function configError(message: string): PipeError {
  return new PipeError("qdrant_config", 503, message);
}

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  collection: string;
}

export function getQdrantConfig(): QdrantConfig {
  const rawUrl = readEnv("QDRANT_URL");
  const collection = readEnv("QDRANT_COLLECTION") || DEFAULT_COLLECTION;
  const apiKey = readEnv("QDRANT_API_KEY");

  if (PLACEHOLDERS.has(rawUrl)) {
    throw configError("Qdrant is not configured. Set QDRANT_URL.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw configError("QDRANT_URL must be a valid HTTP or HTTPS URL.");
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw configError("QDRANT_URL must use HTTP or HTTPS.");
  }

  if (PLACEHOLDERS.has(collection)) {
    throw configError("QDRANT_COLLECTION must be a non-empty collection name.");
  }

  return {
    url: rawUrl.replace(/\/+$/, ""),
    apiKey: apiKey && !PLACEHOLDERS.has(apiKey) ? apiKey : undefined,
    collection,
  };
}

export function qdrantConfigured(): boolean {
  try {
    getQdrantConfig();
    return true;
  } catch {
    return false;
  }
}

let client: QdrantClient | null = null;
let clientSignature = "";

export function getQdrantClient(): QdrantClient {
  const config = getQdrantConfig();
  const signature = `${config.url}\u0000${config.apiKey ?? ""}`;

  if (!client || clientSignature !== signature) {
    client = new QdrantClient({
      url: config.url,
      apiKey: config.apiKey,
      timeout: DEFAULT_TIMEOUT_MS,
    });
    clientSignature = signature;
  }

  return client;
}
