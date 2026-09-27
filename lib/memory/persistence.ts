import type { QdrantClient } from "@qdrant/js-client-rest";
import type { QdrantMemoryDocument, QdrantMemoryWriteResult } from "../qdrant/memory";
import { PipeError } from "../types";
import { buildAgentResultMemory } from "./builders";
import type { AgentMemoryInput, MemoryDocument, MemoryPersistenceStatus } from "./types";

export type MemoryWriter = (
  documents: readonly QdrantMemoryDocument[],
  client?: QdrantClient
) => Promise<QdrantMemoryWriteResult>;

export interface PersistAgentMemoryOptions {
  client?: QdrantClient;
  writer?: MemoryWriter;
}

function safeMemoryError(error: unknown): string {
  return error instanceof PipeError ? error.message : "Qdrant memory persistence failed.";
}

function failureStatus(document: MemoryDocument | null, error: unknown): MemoryPersistenceStatus {
  const kind = error instanceof PipeError ? error.kind : "internal";
  console.error("[memory] agent-result persistence failed", {
    memoryId: document?.id,
    kind,
  });
  return {
    attempted: true,
    persisted: false,
    memoryId: document?.id,
    type: "AGENT_RESULT",
    error: safeMemoryError(error),
  };
}

export async function persistAgentMemory(
  input: AgentMemoryInput,
  options: PersistAgentMemoryOptions = {}
): Promise<MemoryPersistenceStatus> {
  let document: MemoryDocument | null = null;
  try {
    document = buildAgentResultMemory(input);
    const writer = options.writer ?? (async (documents, client) => {
      const { upsertQdrantMemory } = await import("../qdrant/memory");
      return upsertQdrantMemory(documents, client);
    });
    const result = await writer([document], options.client);
    return {
      attempted: true,
      persisted: true,
      memoryId: document.id,
      type: document.metadata.type,
      collection: result.collection,
    };
  } catch (error) {
    return failureStatus(document, error);
  }
}
