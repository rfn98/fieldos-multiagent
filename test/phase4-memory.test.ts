import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import type { QdrantClient } from "@qdrant/js-client-rest";
import { EMBEDDING_DIMENSION } from "../lib/embedding";
import {
  buildAgentResultMemory,
  buildAssetContextMemory,
  buildIncidentMemory,
  buildMaintenanceMemory,
  buildSopMemory,
  buildWorkOrderMemory,
} from "../lib/memory/builders";
import { indexOperationalMemory } from "../lib/memory/indexing";
import type { AgentMemoryInput, MemoryAssetContext } from "../lib/memory/types";
import { retrieveQdrant } from "../lib/qdrant/retrieval";
import { toQdrantPointId, upsertQdrantMemory } from "../lib/qdrant/memory";

const NOW = new Date("2026-09-25T10:00:00.000Z");
const PLANT_ID = "b0000000-0000-4000-8000-000000000001";
const ASSET_ID = "a0000000-0000-4000-8000-0000000002a4";
const WORK_ORDER_ID = "c0000000-0000-4000-8000-000000000003";
const INCIDENT_ID = "d0000000-0000-4000-8000-000000000004";
const MAINTENANCE_ID = "e0000000-0000-4000-8000-000000000005";
const SOP_ID = "f0000000-0000-4000-8000-000000000006";

const plant = {
  id: PLANT_ID,
  code: "PLANT-A",
  name: "Cikarang Manufacturing Plant",
  location: "Cikarang",
  createdAt: NOW,
  updatedAt: NOW,
};

const asset: MemoryAssetContext = {
  id: ASSET_ID,
  code: "P-204",
  name: "Cooling Water Pump",
  manufacturer: "Grundfos",
  model: "CR 32-4",
  status: "CRITICAL",
  plant,
  createdAt: NOW,
  updatedAt: NOW,
  incidentCount: 1,
  maintenanceCount: 1,
  workOrderCount: 1,
  sopCount: 1,
};

const incident = {
  id: INCIDENT_ID,
  code: "INC-2026-002",
  title: "Unexpected pump shutdown",
  description: "The pump unexpectedly shut down.",
  rootCause: "Heavy intake filter contamination.",
  severity: "CRITICAL",
  occurredAt: NOW,
  resolvedAt: null,
  asset,
};

const maintenance = {
  id: MAINTENANCE_ID,
  code: "MR-2026-002",
  type: "PREVENTIVE",
  title: "Filter inspection",
  description: "Inspect the intake filter.",
  actionTaken: "Cleaned the filter.",
  performedAt: NOW,
  asset,
};

const workOrder = {
  id: WORK_ORDER_ID,
  code: "WO-2026-004",
  title: "Follow-up inspection",
  description: "Inspect the pump after restart.",
  priority: "HIGH",
  status: "OPEN",
  scheduledAt: NOW,
  completedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  asset,
};

const sop = {
  id: SOP_ID,
  code: "SOP-014",
  title: "Intake filter inspection",
  category: "INSPECTION",
  content: "Inspect contamination and verify vibration after restart.",
  createdAt: NOW,
  asset,
};

const agentInput: AgentMemoryInput = {
  input: {
    source: "web",
    transcript: "P-204 is making abnormal vibration.",
    timestamp: NOW.toISOString(),
    sessionId: "worker-1",
    metadata: {},
  },
  asset,
  triage: {
    intent: "REPORT_ISSUE",
    assetId: ASSET_ID,
    plantId: PLANT_ID,
    issue: "Abnormal vibration",
    severity: "HIGH",
    requiresInvestigation: true,
  },
  investigation: {
    findings: ["A relevant maintenance record was retrieved."],
    probableIssue: "Filter contamination",
    supportingEvidence: [sop.id],
    recommendedAction: "CREATE_WORK_ORDER",
    rationale: "Follow-up is required.",
    existingWorkOrderCodes: [],
  },
  action: {
    actionType: "CREATE_WORK_ORDER",
    entity: "work_order",
    id: WORK_ORDER_ID,
    code: "WO-2026-004",
    assetId: ASSET_ID,
    assetCode: "P-204",
    summary: "Work order created.",
    details: { status: "OPEN", priority: "HIGH" },
  },
  verification: {
    success: true,
    summary: "The work order was read back from PostgreSQL.",
  },
};

type StoredPoint = {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
};

type FilterClause = {
  key?: string;
  match?: { value?: unknown; any?: unknown[] };
  must?: FilterClause[];
  should?: FilterClause[];
};

function clauseMatches(payload: Record<string, unknown>, clause: FilterClause): boolean {
  if (clause.must) return clause.must.every((nested) => clauseMatches(payload, nested));
  if (clause.should) return clause.should.some((nested) => clauseMatches(payload, nested));
  if (clause.key === undefined) return true;
  const actual = payload[clause.key];
  const match = clause.match;
  if (!match) return actual !== undefined;
  if ("value" in match && match.value !== undefined) return actual === match.value;
  if (match.any) return match.any.includes(actual);
  return true;
}

function matchesFilter(payload: Record<string, unknown>, filter: unknown): boolean {
  if (filter === undefined || filter === null) return true;
  const { must, should } = filter as { must?: FilterClause[]; should?: FilterClause[] };
  if (must && !must.every((clause) => clauseMatches(payload, clause))) return false;
  if (should && !should.some((clause) => clauseMatches(payload, clause))) return false;
  return true;
}

class FakeQdrant {
  readonly points = new Map<string, StoredPoint>();
  readonly payloadSchema: Record<string, unknown> = {};
  collectionCreated = false;
  lastFilter: unknown = null;
  recreateCalls = 0;

  async collectionExists(): Promise<{ exists: boolean }> {
    return { exists: this.collectionCreated };
  }

  async createCollection(): Promise<void> {
    this.collectionCreated = true;
  }

  async getCollection(): Promise<{ payload_schema: Record<string, unknown> }> {
    return { payload_schema: this.payloadSchema };
  }

  async createPayloadIndex(
    _collection: string,
    body: { field_name: string; field_schema: string }
  ): Promise<void> {
    this.payloadSchema[body.field_name] = body.field_schema;
  }

  async upsert(_collection: string, body: { points: StoredPoint[] }): Promise<void> {
    for (const point of body.points) this.points.set(String(point.id), point);
  }

  async retrieve(
    _collection: string,
    body: { ids: Array<string | number> }
  ): Promise<StoredPoint[]> {
    return body.ids
      .map((id) => this.points.get(String(id)))
      .filter((point): point is StoredPoint => Boolean(point));
  }

  async query(
    _collection: string,
    body: { filter?: unknown }
  ): Promise<{ points: Array<{ id: string; score: number; payload: Record<string, unknown> }> }> {
    this.lastFilter = body.filter;
    return {
      points: Array.from(this.points.values())
        .filter((point) => matchesFilter(point.payload, body.filter))
        .map((point) => ({
          id: point.id,
          score: 0.95,
          payload: point.payload,
        })),
    };
  }

  async recreateCollection(): Promise<void> {
    this.recreateCalls += 1;
    this.points.clear();
  }
}

let collectionCounter = 0;

function configureQdrant(): () => void {
  const names = ["QDRANT_URL", "QDRANT_COLLECTION", "QDRANT_API_KEY"] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  process.env.QDRANT_URL = "http://qdrant.test";
  process.env.QDRANT_COLLECTION = `phase4-${process.pid}-${Date.now()}-${collectionCounter++}`;
  delete process.env.QDRANT_API_KEY;
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

function fakeEmbedding(): Promise<number[]> {
  return Promise.resolve(new Array(EMBEDDING_DIMENSION).fill(0));
}

function fakePrisma(): PrismaClient {
  return {
    asset: { findMany: async () => [{ ...asset, _count: { incidents: 1, maintenanceRecords: 1, workOrders: 1, sops: 1 } }] },
    incident: { findMany: async () => [incident] },
    maintenanceRecord: { findMany: async () => [maintenance] },
    workOrder: { findMany: async () => [workOrder] },
    sop: { findMany: async () => [sop] },
  } as unknown as PrismaClient;
}

test("memory builders use actual IDs and deterministic memory identities", () => {
  assert.equal(buildIncidentMemory(incident).metadata.incident_id, INCIDENT_ID);
  assert.equal(buildMaintenanceMemory(maintenance).metadata.maintenance_id, MAINTENANCE_ID);
  assert.equal(buildWorkOrderMemory(workOrder).metadata.work_order_id, WORK_ORDER_ID);
  assert.equal(buildSopMemory(sop).metadata.sop_id, SOP_ID);
  assert.equal(buildAssetContextMemory(asset).metadata.asset_id, ASSET_ID);

  const first = buildAgentResultMemory(agentInput);
  const second = buildAgentResultMemory(agentInput);
  assert.equal(first.id, `agent-result:create_work_order:${WORK_ORDER_ID}`);
  assert.equal(first.id, second.id);
  assert.equal(first.metadata.action_type, "CREATE_WORK_ORDER");
  assert.equal(first.metadata.work_order_id, WORK_ORDER_ID);
  assert.equal(first.metadata.asset_id, ASSET_ID);
  assert.equal(first.metadata.source, "workflow");
  assert.equal(toQdrantPointId(first.id), toQdrantPointId(second.id));
});

test("initial operational indexing is idempotent and preserves collection points", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();
  const client = fakePrisma();

  try {
    const first = await indexOperationalMemory({
      prismaClient: client,
      qdrantClient: qdrant as unknown as QdrantClient,
      embed: fakeEmbedding,
    });
    const second = await indexOperationalMemory({
      prismaClient: client,
      qdrantClient: qdrant as unknown as QdrantClient,
      embed: fakeEmbedding,
    });

    assert.equal(first.recordsDiscovered, 5);
    assert.equal(first.recordsIndexed, 5);
    assert.equal(first.recordsInserted, 5);
    assert.equal(first.recordsUpdated, 0);
    assert.equal(second.recordsInserted, 0);
    assert.equal(second.recordsUpdated, 5);
    assert.equal(qdrant.points.size, 5);
    assert.equal(qdrant.recreateCalls, 0);
    assert.deepEqual(
      new Set(Array.from(qdrant.points.values()).map((point) => point.payload.source_id)),
      new Set([
        `asset:${ASSET_ID}`,
        `incident:${INCIDENT_ID}`,
        `maintenance:${MAINTENANCE_ID}`,
        `work-order:${WORK_ORDER_ID}`,
        `sop:${SOP_ID}`,
      ])
    );
  } finally {
    restore();
  }
});

test("Qdrant retrieval returns memory identity and actual asset metadata", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();

  try {
    await indexOperationalMemory({
      prismaClient: fakePrisma(),
      qdrantClient: qdrant as unknown as QdrantClient,
      embed: fakeEmbedding,
    });
    const result = await retrieveQdrant(
      "What is the current work order for P-204?",
      { assetId: ASSET_ID, plantId: PLANT_ID, topK: 10, embed: fakeEmbedding },
      qdrant as unknown as QdrantClient
    );
    const workOrderDocument = result.docs.find((doc) => doc.type === "WORK_ORDER");

    assert.ok(workOrderDocument);
    assert.equal(workOrderDocument.memoryId, `work-order:${WORK_ORDER_ID}`);
    assert.equal(workOrderDocument.assetId, ASSET_ID);
    assert.equal(workOrderDocument.plantId, PLANT_ID);
    assert.equal(workOrderDocument.source, "postgres");
    assert.equal(workOrderDocument.content, workOrderDocument.text);
    assert.deepEqual(qdrant.lastFilter, {
      must: [
        { should: [{ key: "asset_id", match: { value: ASSET_ID } }] },
        { should: [{ key: "plant_id", match: { value: PLANT_ID } }] },
      ],
    });
  } finally {
    restore();
  }
});

test("retrieval includes legacy code aliases and prefers canonical memories", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();

  try {
    await qdrant.upsert("legacy", {
      points: [
        {
          id: toQdrantPointId("INC-2026-002"),
          vector: new Array(EMBEDDING_DIMENSION).fill(0),
          payload: {
            source_id: "INC-2026-002",
            text: "Legacy incident memory",
            type: "INCIDENT",
            asset_id: "P-204",
            plant_id: "PLANT-A",
          },
        },
      ],
    });
    await indexOperationalMemory({
      prismaClient: fakePrisma(),
      qdrantClient: qdrant as unknown as QdrantClient,
      embed: fakeEmbedding,
    });
    const result = await retrieveQdrant(
      "P-204 incident memory",
      {
        assetId: ASSET_ID,
        assetCode: "P-204",
        plantId: PLANT_ID,
        plantCode: "PLANT-A",
        topK: 10,
        embed: fakeEmbedding,
      },
      qdrant as unknown as QdrantClient
    );

    assert.deepEqual(qdrant.lastFilter, {
      must: [
        {
          should: [
            { key: "asset_id", match: { value: ASSET_ID } },
            { key: "asset_code", match: { value: "P-204" } },
            { key: "asset_id", match: { value: "P-204" } },
          ],
        },
        {
          should: [
            { key: "plant_id", match: { value: PLANT_ID } },
            { key: "plant_code", match: { value: "PLANT-A" } },
            { key: "plant_id", match: { value: "PLANT-A" } },
          ],
        },
      ],
    });
    assert.equal(result.docs.filter((doc) => doc.metadata.type === "INCIDENT").length, 1);
    assert.equal(result.docs.some((doc) => doc.memoryId === "INC-2026-002"), false);
    assert.equal(result.docs.some((doc) => doc.memoryId === `incident:${INCIDENT_ID}`), true);
  } finally {
    restore();
  }
});

test("asset code filters match the asset_code field, not only the asset_id uuid", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();

  try {
    await upsertQdrantMemory(
      [
        {
          id: `incident:${INCIDENT_ID}`,
          text: "P-204 incident memory",
          metadata: {
            type: "INCIDENT",
            asset_id: ASSET_ID,
            asset_code: "P-204",
            plant_id: PLANT_ID,
            plant_code: "PLANT-A",
            source: "postgres",
          },
        },
        {
          id: "incident:other-asset",
          text: "M-101 incident memory",
          metadata: {
            type: "INCIDENT",
            asset_id: "99999999-9999-4999-8999-999999999999",
            asset_code: "M-101",
            plant_id: PLANT_ID,
            plant_code: "PLANT-A",
            source: "postgres",
          },
        },
      ],
      qdrant as unknown as QdrantClient,
      { embed: fakeEmbedding }
    );

    const byCode = await retrieveQdrant(
      "abnormal vibration",
      { assetCode: "P-204", topK: 5 },
      qdrant as unknown as QdrantClient
    );
    assert.equal(byCode.docs.length, 1);
    assert.equal(byCode.docs[0].id, `incident:${INCIDENT_ID}`);

    const byId = await retrieveQdrant(
      "abnormal vibration",
      { assetId: ASSET_ID, topK: 5 },
      qdrant as unknown as QdrantClient
    );
    assert.equal(byId.docs.length, 1);
    assert.equal(byId.docs[0].id, `incident:${INCIDENT_ID}`);

    const byLegacyIdCode = await retrieveQdrant(
      "abnormal vibration",
      { assetId: "P-204", topK: 5 },
      qdrant as unknown as QdrantClient
    );
    assert.equal(byLegacyIdCode.docs.length, 0);
  } finally {
    restore();
  }
});

test("operational indexing reports embedding failures without writing points", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();

  try {
    const report = await indexOperationalMemory({
      prismaClient: fakePrisma(),
      qdrantClient: qdrant as unknown as QdrantClient,
      embed: async () => {
        throw new Error("embedding unavailable");
      },
    });

    assert.equal(report.recordsDiscovered, 5);
    assert.equal(report.recordsIndexed, 0);
    assert.equal(report.failures, 1);
    assert.match(report.failureMessages[0], /embedding unavailable/);
    assert.equal(qdrant.points.size, 0);
  } finally {
    restore();
  }
});

test("direct Qdrant writes classify existing points without duplication", async () => {
  const restore = configureQdrant();
  const qdrant = new FakeQdrant();
  const document = {
    id: `work-order:${WORK_ORDER_ID}`,
    text: "Work order memory",
    metadata: { type: "WORK_ORDER", asset_id: ASSET_ID, plant_id: PLANT_ID, source: "postgres" },
  };

  try {
    const first = await upsertQdrantMemory(
      [document],
      qdrant as unknown as QdrantClient,
      { classifyExisting: true, embed: fakeEmbedding }
    );
    const second = await upsertQdrantMemory(
      [document],
      qdrant as unknown as QdrantClient,
      { classifyExisting: true, embed: fakeEmbedding }
    );

    assert.equal(first.inserted, 1);
    assert.equal(first.updated, 0);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    assert.equal(qdrant.points.size, 1);
  } finally {
    restore();
  }
});
