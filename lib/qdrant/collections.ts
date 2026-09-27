import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { EMBEDDING_DIMENSION } from "../embedding";
import { PipeError } from "../types";
import { getQdrantClient, getQdrantConfig } from "./client";

type PayloadIndex = {
  fieldName: string;
  fieldSchema: Schemas["PayloadSchemaType"];
};

const PAYLOAD_INDEXES: PayloadIndex[] = [
  { fieldName: "asset_id", fieldSchema: "keyword" },
  { fieldName: "plant_id", fieldSchema: "keyword" },
  { fieldName: "asset_code", fieldSchema: "keyword" },
  { fieldName: "plant_code", fieldSchema: "keyword" },
  { fieldName: "type", fieldSchema: "keyword" },
  { fieldName: "source", fieldSchema: "keyword" },
  { fieldName: "session_id", fieldSchema: "keyword" },
  { fieldName: "date", fieldSchema: "keyword" },
  { fieldName: "status", fieldSchema: "keyword" },
  { fieldName: "priority", fieldSchema: "keyword" },
  { fieldName: "action_type", fieldSchema: "keyword" },
  { fieldName: "workflow_id", fieldSchema: "keyword" },
];

const initializedCollections = new WeakMap<QdrantClient, Set<string>>();
const initializingCollections = new WeakMap<QdrantClient, Map<string, Promise<void>>>();

function collectionState(client: QdrantClient): {
  initialized: Set<string>;
  initializing: Map<string, Promise<void>>;
} {
  let initialized = initializedCollections.get(client);
  if (!initialized) {
    initialized = new Set<string>();
    initializedCollections.set(client, initialized);
  }
  let initializing = initializingCollections.get(client);
  if (!initializing) {
    initializing = new Map<string, Promise<void>>();
    initializingCollections.set(client, initializing);
  }
  return { initialized, initializing };
}

function requestError(action: string, error: unknown): PipeError {
  if (error instanceof PipeError) return error;
  return new PipeError("qdrant_request", 502, `Qdrant ${action} failed.`);
}

async function createPayloadIndexes(
  client: QdrantClient,
  collectionName: string
): Promise<void> {
  const collection = await client.getCollection(collectionName);
  const payloadSchema = collection.payload_schema ?? {};

  for (const index of PAYLOAD_INDEXES) {
    if (payloadSchema[index.fieldName]) continue;
    await client.createPayloadIndex(collectionName, {
      wait: true,
      field_name: index.fieldName,
      field_schema: index.fieldSchema,
    });
  }
}

async function initializeCollection(
  client: QdrantClient,
  collectionName: string,
  recreate: boolean
): Promise<void> {
  try {
    if (recreate) {
      await client.recreateCollection(collectionName, {
        vectors: {
          size: EMBEDDING_DIMENSION,
          distance: "Cosine",
        },
      });
    } else {
      const existence = await client.collectionExists(collectionName);
      if (!existence.exists) {
        await client.createCollection(collectionName, {
          vectors: {
            size: EMBEDDING_DIMENSION,
            distance: "Cosine",
          },
        });
      }
    }

    await createPayloadIndexes(client, collectionName);
    collectionState(client).initialized.add(collectionName);
  } catch (error) {
    throw requestError("collection initialization", error);
  }
}

export function ensureQdrantCollection(client: QdrantClient = getQdrantClient()): Promise<void> {
  const { collection } = getQdrantConfig();
  const state = collectionState(client);
  if (state.initialized.has(collection)) return Promise.resolve();

  const existing = state.initializing.get(collection);
  if (existing) return existing;

  const promise = initializeCollection(client, collection, false).catch((error: unknown) => {
    state.initializing.delete(collection);
    throw error;
  });
  state.initializing.set(collection, promise);
  return promise;
}

export function recreateQdrantCollection(
  client: QdrantClient = getQdrantClient()
): Promise<void> {
  const { collection } = getQdrantConfig();
  const state = collectionState(client);
  state.initialized.delete(collection);
  state.initializing.delete(collection);
  return initializeCollection(client, collection, true);
}

export function qdrantCollectionName(): string {
  return getQdrantConfig().collection;
}
