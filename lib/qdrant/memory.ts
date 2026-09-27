import { createHash } from "node:crypto";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { embedText, EMBEDDING_DIMENSION } from "../embedding";
import { PipeError } from "../types";
import { ensureQdrantCollection } from "./collections";
import { getQdrantClient, getQdrantConfig } from "./client";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function toQdrantPointId(sourceId: string): string {
  if (UUID_PATTERN.test(sourceId)) return sourceId;
  const bytes = Buffer.from(
    createHash("sha256").update(sourceId).digest("hex").slice(0, 32),
    "hex"
  );
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface QdrantMemoryDocument {
  id: string;
  text: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface QdrantMemoryWriteOptions {
  classifyExisting?: boolean;
  embed?: (text: string) => Promise<number[]>;
}

export interface QdrantMemoryWriteResult {
  collection: string;
  count: number;
  inserted: number;
  updated: number;
}

function cleanMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

export async function upsertQdrantMemory(
  documents: readonly QdrantMemoryDocument[],
  client: QdrantClient = getQdrantClient(),
  options: QdrantMemoryWriteOptions = {}
): Promise<QdrantMemoryWriteResult> {
  await ensureQdrantCollection(client);
  const { collection } = getQdrantConfig();
  const embed = options.embed ?? embedText;
  const points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }> = [];

  for (const document of documents) {
    const id = document.id.trim();
    const text = document.text.trim();
    if (!id || !text) {
      throw new PipeError("invalid_request", 400, "Qdrant memory documents require an id and text.");
    }

    const vector = await embed(text);
    if (vector.length !== EMBEDDING_DIMENSION) {
      throw new PipeError(
        "qdrant_request",
        502,
        `Embedding dimension was ${vector.length}, expected ${EMBEDDING_DIMENSION}.`
      );
    }

    points.push({
      id: toQdrantPointId(id),
      vector,
      payload: {
        ...cleanMetadata(document.metadata),
        source_id: id,
        text,
      },
    });
  }

  if (points.length === 0) {
    return { collection, count: 0, inserted: 0, updated: 0 };
  }

  const existingIds = new Set<string>();
  if (options.classifyExisting) {
    try {
      const existing = await client.retrieve(collection, {
        ids: points.map((point) => point.id),
        with_payload: false,
        with_vector: false,
      });
      for (const point of existing) existingIds.add(String(point.id));
    } catch (error) {
      if (error instanceof PipeError) throw error;
      throw new PipeError("qdrant_request", 502, "Qdrant memory classification failed.");
    }
  }

  try {
    await client.upsert(collection, {
      wait: true,
      points,
    });
  } catch (error) {
    if (error instanceof PipeError) throw error;
    throw new PipeError("qdrant_request", 502, "Qdrant memory write failed.");
  }

  const updated = existingIds.size;
  return {
    collection,
    count: points.length,
    inserted: points.length - updated,
    updated,
  };
}
