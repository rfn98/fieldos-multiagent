import type { PrismaClient } from "@prisma/client";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { prisma } from "../prisma";
import { getQdrantClient } from "../qdrant/client";
import { EMBEDDING_DIMENSION } from "../embedding";
import { upsertQdrantMemory, type QdrantMemoryWriteOptions } from "../qdrant/memory";
import {
  buildAssetContextMemory,
  buildIncidentMemory,
  buildMaintenanceMemory,
  buildSopMemory,
  buildWorkOrderMemory,
} from "./builders";
import type { MemoryDocument } from "./types";

export interface MemoryIndexOptions {
  prismaClient?: PrismaClient;
  qdrantClient?: QdrantClient;
  embed?: (text: string) => Promise<number[]>;
}

export interface MemoryIndexReport {
  collection: string;
  recordsDiscovered: number;
  recordsIndexed: number;
  recordsInserted: number;
  recordsUpdated: number;
  failures: number;
  failureMessages: string[];
  embeddingDimension: number;
  distance: "Cosine";
}

function reportCollection(): string {
  return process.env.QDRANT_COLLECTION?.trim() || "fieldos-knowledge";
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown operational memory indexing failure.";
}

export async function loadOperationalMemoryDocuments(
  client: PrismaClient = prisma
): Promise<MemoryDocument[]> {
  const [assets, incidents, maintenanceRecords, workOrders, sops] = await Promise.all([
    client.asset.findMany({
      include: {
        plant: true,
        _count: { select: { incidents: true, maintenanceRecords: true, workOrders: true, sops: true } },
      },
    }),
    client.incident.findMany({ include: { asset: { include: { plant: true } } } }),
    client.maintenanceRecord.findMany({ include: { asset: { include: { plant: true } } } }),
    client.workOrder.findMany({ include: { asset: { include: { plant: true } } } }),
    client.sop.findMany({ include: { asset: { include: { plant: true } } } }),
  ]);

  return [
    ...assets.map((asset) =>
      buildAssetContextMemory({
        ...asset,
        incidentCount: asset._count.incidents,
        maintenanceCount: asset._count.maintenanceRecords,
        workOrderCount: asset._count.workOrders,
        sopCount: asset._count.sops,
      })
    ),
    ...incidents.map((incident) => buildIncidentMemory(incident)),
    ...maintenanceRecords.map((record) => buildMaintenanceMemory(record)),
    ...workOrders.map((workOrder) => buildWorkOrderMemory(workOrder)),
    ...sops.map((sop) => buildSopMemory(sop)),
  ];
}

export async function indexOperationalMemory(
  options: MemoryIndexOptions = {}
): Promise<MemoryIndexReport> {
  let documents: MemoryDocument[] = [];
  try {
    const client = options.prismaClient ?? prisma;
    const qdrantClient = options.qdrantClient ?? getQdrantClient();
    documents = await loadOperationalMemoryDocuments(client);
    const writeOptions: QdrantMemoryWriteOptions = {
      classifyExisting: true,
      ...(options.embed ? { embed: options.embed } : {}),
    };
    const result = await upsertQdrantMemory(documents, qdrantClient, writeOptions);
    return {
      collection: result.collection,
      recordsDiscovered: documents.length,
      recordsIndexed: result.count,
      recordsInserted: result.inserted,
      recordsUpdated: result.updated,
      failures: 0,
      failureMessages: [],
      embeddingDimension: EMBEDDING_DIMENSION,
      distance: "Cosine",
    };
  } catch (error) {
    return {
      collection: reportCollection(),
      recordsDiscovered: documents.length,
      recordsIndexed: 0,
      recordsInserted: 0,
      recordsUpdated: 0,
      failures: 1,
      failureMessages: [failureMessage(error)],
      embeddingDimension: EMBEDDING_DIMENSION,
      distance: "Cosine",
    };
  }
}

export async function disconnectMemoryDatabase(): Promise<void> {
  await prisma.$disconnect();
}
