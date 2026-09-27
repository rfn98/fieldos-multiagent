import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { embedText } from "../embedding";
import { PipeError } from "../types";
import { ensureQdrantCollection } from "./collections";
import { getQdrantClient, getQdrantConfig } from "./client";

const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 100;

export interface QdrantDocument {
  id: string;
  text: string;
  content: string;
  score: number;
  memoryId: string;
  type?: string;
  assetId?: string;
  plantId?: string;
  workflowId?: string;
  source?: string;
  metadata: Record<string, string>;
}

export interface QdrantRetrieval {
  docs: QdrantDocument[];
  latencyMs: number;
  collectionName: string;
  query: string;
}

export interface QdrantRetrievalOptions {
  topK?: number;
  assetId?: string;
  assetCode?: string;
  plantId?: string;
  plantCode?: string;
  type?: string;
  filters?: Readonly<Record<string, string>>;
  embed?: (text: string) => Promise<number[]>;
}

function normalizeTopK(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TOP_K;
  if (!Number.isInteger(value) || value < 1 || value > MAX_TOP_K) {
    throw new PipeError("invalid_request", 400, `topK must be an integer from 1 to ${MAX_TOP_K}.`);
  }
  return value;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))
  );
}

function matchCondition(key: string, values: string[]): Schemas["Condition"] {
  return {
    key,
    match: values.length === 1 ? { value: values[0] } : { any: values },
  };
}

function buildFilter(options: QdrantRetrievalOptions): Schemas["Filter"] | undefined {
  const values: Record<string, string> = {};

  for (const [key, value] of Object.entries(options.filters ?? {})) {
    const normalized = value.trim();
    if (key && normalized) values[key] = normalized;
  }

  const assetIds = uniqueStrings([values.asset_id, options.assetId]);
  const plantIds = uniqueStrings([values.plant_id, options.plantId]);
  const assetCodes = uniqueStrings([values.asset_code, options.assetCode]);
  const plantCodes = uniqueStrings([values.plant_code, options.plantCode]);
  const type = options.type?.trim();
  if (type) values.type = type;

  const RESERVED_KEYS = new Set(["asset_id", "plant_id", "asset_code", "plant_code"]);
  const conditions: Schemas["Condition"][] = [];
  for (const [key, value] of Object.entries(values)) {
    if (RESERVED_KEYS.has(key)) continue;
    conditions.push(matchCondition(key, [value]));
  }

  function entityConditions(
    ids: string[],
    codes: string[],
    idKey: string,
    codeKey: string
  ): Schemas["Condition"][] {
    const clauses: Schemas["Condition"][] = [];
    if (ids.length > 0) clauses.push(matchCondition(idKey, ids));
    if (codes.length > 0) {
      clauses.push(matchCondition(codeKey, codes));
      clauses.push(matchCondition(idKey, codes));
    }
    return clauses;
  }

  const assetConditions = entityConditions(assetIds, assetCodes, "asset_id", "asset_code");
  const plantConditions = entityConditions(plantIds, plantCodes, "plant_id", "plant_code");

  if (assetConditions.length > 0 && plantConditions.length > 0) {
    conditions.push({ should: assetConditions });
    conditions.push({ should: plantConditions });
  } else if (assetConditions.length > 0) {
    conditions.push({ should: assetConditions });
  } else if (plantConditions.length > 0) {
    conditions.push({ should: plantConditions });
  }

  return conditions.length > 0 ? { must: conditions } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function metadataFromPayload(payload: Record<string, unknown>): Record<string, string> {
  const metadata: Record<string, string> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === "text") continue;
    const normalized = stringValue(value);
    if (normalized !== undefined) metadata[key] = normalized;
  }

  if (metadata.plant_id && !metadata.plantId) metadata.plantId = metadata.plant_id;
  if (metadata.asset_id && !metadata.assetId) metadata.assetId = metadata.asset_id;

  return metadata;
}

const CODE_METADATA_KEYS: Record<string, string> = {
  asset_context: "asset_code",
  incident: "incident_code",
  maintenance: "maintenance_code",
  work_order: "work_order_code",
  sop: "sop_code",
};

function normalizedMemoryType(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function namespacedMemoryId(value: string): boolean {
  return /^(asset|incident|maintenance|work-order|sop|agent-result):/.test(value);
}

function canonicalMemoryKey(document: QdrantDocument): string {
  const type = normalizedMemoryType(document.type ?? document.metadata.type);
  const codeKey = CODE_METADATA_KEYS[type];
  const code = codeKey ? document.metadata[codeKey] : undefined;
  const identity = code ?? document.memoryId;
  return `${type}:${identity}`;
}

function deduplicateDocuments(documents: readonly QdrantDocument[]): QdrantDocument[] {
  const selected = new Map<string, QdrantDocument>();
  for (const document of documents) {
    const key = canonicalMemoryKey(document);
    const existing = selected.get(key);
    const preferCurrent =
      existing && document.score === existing.score && namespacedMemoryId(document.memoryId) && !namespacedMemoryId(existing.memoryId);
    if (!existing || document.score > existing.score || preferCurrent) {
      selected.set(key, document);
    }
  }
  return Array.from(selected.values()).sort((left, right) => right.score - left.score);
}

export async function retrieveQdrant(
  question: string,
  options: QdrantRetrievalOptions = {},
  client: QdrantClient = getQdrantClient()
): Promise<QdrantRetrieval> {
  const query = question.trim();
  if (!query) {
    throw new PipeError("invalid_request", 400, "question must be a non-empty string.");
  }

  const topK = normalizeTopK(options.topK);
  const { collection } = getQdrantConfig();
  const startedAt = performance.now();

  try {
    await ensureQdrantCollection(client);
    const vector = await (options.embed ?? embedText)(query);
    const queryLimit = options.assetCode || options.plantCode ? Math.min(MAX_TOP_K, topK * 2) : topK;
    const response = await client.query(collection, {
      query: vector,
      filter: buildFilter(options),
      limit: queryLimit,
      with_payload: true,
      with_vector: false,
    });
    const docs: QdrantDocument[] = response.points.map((point) => {
      const payload = isRecord(point.payload) ? point.payload : {};
      const text = stringValue(payload.text)?.trim();
      if (!text) {
        throw new PipeError("qdrant_request", 502, "Qdrant returned an evidence point without text.");
      }

      const memoryId =
        stringValue(payload.source_id)?.trim() ||
        stringValue(payload.memoryId)?.trim() ||
        stringValue(payload.memory_id)?.trim() ||
        String(point.id);
      const metadata = metadataFromPayload(payload);
      return {
        id: memoryId,
        text,
        content: text,
        score: point.score,
        memoryId,
        type: metadata.type,
        assetId: metadata.asset_id ?? metadata.assetId,
        plantId: metadata.plant_id ?? metadata.plantId,
        workflowId: metadata.workflow_id ?? metadata.workflowId,
        source: metadata.source,
        metadata,
      };
    });

    return {
      docs: deduplicateDocuments(docs).slice(0, topK),
      latencyMs: Math.round(performance.now() - startedAt),
      collectionName: collection,
      query,
    };
  } catch (error) {
    if (error instanceof PipeError) throw error;
    throw new PipeError("qdrant_request", 502, "Qdrant retrieval failed.");
  }
}
