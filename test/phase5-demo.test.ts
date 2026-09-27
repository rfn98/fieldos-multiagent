import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { buildAgentResultMemory } from "../lib/memory/builders";
import type { QdrantDocument } from "../lib/qdrant/retrieval";
import { buildWorkflowTrace, inputSourceLabel } from "../lib/workflow/trace";
import { runInvestigationWorkflow } from "../lib/workflow/orchestrator";
import type { NormalizedInvestigationInput, WorkflowStageId } from "../lib/types";

const NOW = new Date("2026-09-25T10:00:00.000Z");

const DEMO_ONE = "Pump P-204 is vibrating again. The vibration feels stronger than yesterday.";
const DEMO_TWO = "What's the status of the pump I reported yesterday?";

function stage(trace: { stages: Array<{ id: WorkflowStageId; state: string; detail: string | null }> }, id: WorkflowStageId) {
  const found = trace.stages.find((item) => item.id === id);
  assert.ok(found, `expected stage ${id} to exist`);
  return found;
}

function seedState() {
  const workOrders: Array<Record<string, unknown>> = [];
  const incidents: Array<Record<string, unknown>> = [];
  return { workOrders, incidents, writes: 0 };
}

function fakeClient(state: ReturnType<typeof seedState>, failReadBack = false) {
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
    id: "a0000000-0000-4000-8000-0000000002a4",
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
    sops: [
      {
        id: "sop-1",
        code: "SOP-014",
        assetId: "a0000000-0000-4000-8000-0000000002a4",
        title: "P-204 Intake Filter Inspection Procedure",
        category: "INSPECTION",
        content: "Inspect the intake filter and verify vibration after restart.",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
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
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id && failReadBack) return null;
        return state.workOrders.find((r) => r.id === where.id || r.code === where.code) ?? null;
      },
      findFirst: async ({ where }: { where: { assetId?: string; status?: string } }) =>
        state.workOrders.find(
          (r) =>
            (!where.assetId || r.assetId === where.assetId) &&
            (!where.status || r.status === where.status)
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `wo-${state.workOrders.length + 1}`, createdAt: NOW, updatedAt: NOW, technician, ...data };
        state.workOrders.push(record);
        asset.workOrders.push(record);
        state.writes += 1;
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = state.workOrders.find((r) => r.id === where.id);
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
        const record = state.incidents.find((r) => r.id === where.id);
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

async function withMockLyzr<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previous;
  }
}

test("trace exposes all seven stages in order for a completed mutation run", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "demo-1" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async () => ({
          attempted: true,
          persisted: true,
          memoryId: "AGENT_RESULT-abc123",
          type: "AGENT_RESULT" as const,
          collection: "fieldos-knowledge",
        }),
        now: () => NOW,
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace, "expected a trace on the workflow result");
    assert.deepEqual(
      trace.stages.map((s) => s.id),
      [
        "input",
        "triage",
        "memory_retrieval",
        "investigation",
        "action",
        "database_verification",
        "memory_persistence",
      ]
    );

    assert.equal(stage(trace, "input").state, "completed");
    assert.equal(stage(trace, "triage").state, "completed");
    assert.equal(stage(trace, "memory_retrieval").state, "completed");
    assert.equal(stage(trace, "investigation").state, "completed");
    assert.equal(stage(trace, "action").state, "completed");
    assert.equal(stage(trace, "database_verification").state, "completed");
    assert.equal(stage(trace, "memory_persistence").state, "completed");
    assert.equal(trace.status, "completed");
  });
});

test("trace reports failed verification instead of a completed stage", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state, true);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "demo-fail" },
      { client, retrieve: async () => sopRetrieval(), now: () => NOW }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "failed");
    assert.equal(stage(trace, "database_verification").state, "failed");
    assert.equal(trace.verification?.success, false);
    assert.equal(trace.action?.verified, false);
  });
});

test("trace renders retrieved memory with type, asset, score and preview", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "demo-mem" },
      { client, retrieve: async () => sopRetrieval(), now: () => NOW }
    );

    const memories = result.workflow?.trace.memories ?? [];
    assert.equal(memories.length, 1);
    assert.equal(memories[0].type, "sop");
    assert.equal(memories[0].asset, "P-204");
    assert.equal(memories[0].plant, "PLANT-A");
    assert.equal(memories[0].score, 0.97);
    assert.ok(memories[0].preview.length > 0);
  });
});

test("trace surfaces agent-result persistence and the memory id", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "demo-persist" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async () => ({
          attempted: true,
          persisted: true,
          memoryId: "AGENT_RESULT-xyz789",
          type: "AGENT_RESULT" as const,
          collection: "fieldos-knowledge",
        }),
        now: () => NOW,
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.memoryPersistence?.persisted, true);
    assert.equal(trace.memoryPersistence?.memoryId, "AGENT_RESULT-xyz789");
    assert.equal(stage(trace, "memory_persistence").state, "completed");
  });
});

test("second status request recalls memory, resolves the asset from memory, and writes nothing", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client, asset } = fakeClient(state);
    let stored: QdrantDocument | null = null;

    const first = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "worker-1" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async (input) => {
          const memory = buildAgentResultMemory(input);
          stored = {
            id: memory.id,
            text: memory.text,
            content: memory.text,
            memoryId: memory.id,
            score: 0.95,
            type: memory.metadata.type,
            assetId: input.asset.id,
            plantId: input.asset.plant.id,
            source: memory.metadata.source,
            metadata: {
              type: memory.metadata.type,
              asset_code: input.asset.code,
              plant_code: input.asset.plant.code,
              source: memory.metadata.source,
            },
          };
          return {
            attempted: true,
            persisted: true,
            memoryId: memory.id,
            type: "AGENT_RESULT" as const,
            collection: "fieldos-knowledge",
          };
        },
        now: () => NOW,
      }
    );

    assert.equal(first.workflow?.memoryPersistence?.persisted, true);
    assert.ok(stored);
    const memoryDoc = stored as unknown as QdrantDocument;
    assert.equal(state.writes, 1);

    const latest = state.workOrders[state.workOrders.length - 1];
    latest.status = "COMPLETED";
    latest.completedAt = NOW;
    latest.updatedAt = new Date("2026-09-26T10:00:00.000Z");
    asset.workOrders.sort(
      (l, r) => new Date(r.updatedAt as string).getTime() - new Date(l.updatedAt as string).getTime()
    );

    const second = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: "2026-09-26T11:00:00.000Z", sessionId: "worker-2" },
      {
        client,
        retrieveContext: async () => ({
          docs: [memoryDoc],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: DEMO_TWO,
        }),
        retrieve: async () => ({
          docs: [memoryDoc],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: DEMO_TWO,
        }),
        now: () => new Date("2026-09-26T11:00:00.000Z"),
      }
    );

    const trace = second.workflow?.trace;
    assert.ok(trace);
    assert.equal(second.workflow?.action, null);
    assert.equal(state.writes, 1, "second request must not mutate the database");
    assert.equal(trace.action, null);
    assert.equal(stage(trace, "action").state, "skipped");
    assert.equal(stage(trace, "database_verification").state, "skipped");
    assert.equal(trace.assetResolution?.fromMemory, true);
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(trace.memories[0]?.type, "AGENT_RESULT");
    assert.match(second.answer, /COMPLETED/);
  });
});

test("input source is labeled as Omi voice for omi input and dev/test text otherwise", () => {
  assert.deepEqual(inputSourceLabel("omi"), { label: "VOICE INPUT — OMI", channel: "omi_voice" });
  assert.deepEqual(inputSourceLabel("web"), { label: "TEXT INPUT — DEV/TEST", channel: "dev_text" });
});

test("omi-sourced transcript is labeled as Omi voice in the trace", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "omi", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "omi-1" },
      { client, retrieve: async () => sopRetrieval(), now: () => NOW }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.inputSource, "omi");
    assert.equal(trace.inputLabel, "VOICE INPUT — OMI");
    assert.equal(trace.inputChannel, "omi_voice");
    assert.equal(stage(trace, "input").detail, "VOICE INPUT — OMI");
  });
});

test("current status is read from PostgreSQL rather than memory text", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client, asset } = fakeClient(state);
    let stored: QdrantDocument | null = null;

    const first = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "worker-1" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async (input) => {
          const memory = buildAgentResultMemory(input);
          stored = {
            id: memory.id,
            text: memory.text,
            content: memory.text,
            memoryId: memory.id,
            score: 0.95,
            type: memory.metadata.type,
            assetId: input.asset.id,
            plantId: input.asset.plant.id,
            source: memory.metadata.source,
            metadata: {
              type: memory.metadata.type,
              asset_code: input.asset.code,
              plant_code: input.asset.plant.code,
              source: memory.metadata.source,
            },
          };
          return {
            attempted: true,
            persisted: true,
            memoryId: memory.id,
            type: "AGENT_RESULT" as const,
            collection: "fieldos-knowledge",
          };
        },
        now: () => NOW,
      }
    );
    assert.equal(first.workflow?.memoryPersistence?.persisted, true);
    const memoryDoc = stored as unknown as QdrantDocument;

    // The work order is still OPEN in PostgreSQL.
    const latest = state.workOrders[state.workOrders.length - 1];
    latest.status = "OPEN";
    asset.workOrders.sort(
      (l, r) => new Date(r.updatedAt as string).getTime() - new Date(l.updatedAt as string).getTime()
    );

    const second = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: "2026-09-26T11:00:00.000Z", sessionId: "worker-2" },
      {
        client,
        retrieveContext: async () => ({
          docs: [memoryDoc],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: DEMO_TWO,
        }),
        retrieve: async () => ({
          docs: [memoryDoc],
          latencyMs: 1,
          collectionName: "fieldos-knowledge",
          query: DEMO_TWO,
        }),
        now: () => new Date("2026-09-26T11:00:00.000Z"),
      }
    );

    // The answer must reflect the live PostgreSQL row (OPEN), not the memory text.
    assert.match(second.answer, /OPEN/);
    assert.equal(state.writes, 1);
  });
});

test("partial success when Qdrant persistence fails after a verified action", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "demo-partial" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async () => ({
          attempted: true,
          persisted: false,
          error: "Qdrant unavailable",
        }),
        now: () => NOW,
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "completed");
    assert.equal(trace.verification?.success, true);
    assert.equal(trace.action?.verified, true);
    assert.equal(trace.memoryPersistence?.attempted, true);
    assert.equal(trace.memoryPersistence?.persisted, false);
    assert.equal(stage(trace, "memory_persistence").state, "failed");
    assert.equal(stage(trace, "memory_persistence").detail, "Qdrant unavailable");
    assert.equal(state.writes, 1);
  });
});

test("buildWorkflowTrace is pure and does not fabricate stages", () => {
  const input: NormalizedInvestigationInput = {
    source: "web",
    transcript: "anything",
    timestamp: NOW.toISOString(),
    sessionId: "s",
    metadata: {},
  };

  const trace = buildWorkflowTrace({
    input,
    status: "failed",
    asset: null,
    assetFromMemory: false,
    retrieval: null,
    contextRetrieval: null,
    steps: [],
    triage: {
      intent: "REQUEST_INFORMATION",
      assetId: null,
      plantId: null,
      issue: null,
      severity: null,
      requiresInvestigation: false,
    },
    investigation: null,
    action: null,
    verification: null,
    memoryPersistence: null,
  });

  assert.equal(trace.status, "failed");
  assert.equal(trace.assetResolution, null);
  assert.equal(trace.action, null);
  assert.equal(trace.verification, null);
  assert.deepEqual(trace.memories, []);
  for (const role of ["triage", "investigation", "action", "verification"]) {
    const agent = trace.agents.find((a) => a.role === role);
    assert.ok(agent);
    assert.equal(agent.status, "skipped");
  }
});

/* Memory asset disambiguation: AGENT_RESULT anchors vs semantic fallback. */

const P204_ID = "a0000000-0000-4000-8000-0000000002a4";
const M101_ID = "a0000000-0000-4000-8000-000000000101";

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

function contextRetrieval(docs: QdrantDocument[]) {
  return {
    docs,
    latencyMs: 1,
    collectionName: "fieldos-knowledge",
    query: DEMO_TWO,
  };
}

const LATER = "2026-09-26T11:00:00.000Z";

test("memory recall resolves from a single AGENT_RESULT anchor despite higher-scoring distractors", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: LATER, sessionId: "worker-anchor" },
      {
        client,
        retrieveContext: async () =>
          contextRetrieval([
            memoryDoc({ memoryId: `incident:${M101_ID}`, type: "INCIDENT", score: 0.5417, assetId: M101_ID, assetCode: "M-101" }),
            memoryDoc({ memoryId: `maintenance:${M101_ID}`, type: "MAINTENANCE", score: 0.5099, assetId: M101_ID, assetCode: "M-101" }),
            memoryDoc({ memoryId: `maintenance:${P204_ID}`, type: "MAINTENANCE", score: 0.5069, assetId: P204_ID, assetCode: "P-204" }),
            memoryDoc({
              memoryId: "agent-result:create_work_order:anchor-1",
              type: "AGENT_RESULT",
              score: 0.4988,
              assetId: P204_ID,
              assetCode: "P-204",
              source: "workflow",
            }),
            memoryDoc({ memoryId: `work-order:${P204_ID}`, type: "WORK_ORDER", score: 0.4863, assetId: P204_ID, assetCode: "P-204" }),
          ]),
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "completed");
    assert.equal(trace.assetResolution?.fromMemory, true);
    assert.equal(trace.assetResolution?.basis, "agent_result_memory");
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(result.workflow?.action, null);
    assert.equal(trace.action, null);
    assert.equal(stage(trace, "action").state, "skipped");
    assert.equal(stage(trace, "database_verification").state, "skipped");
    assert.equal(state.writes, 0, "recall must not mutate the database");
    // Status text comes from the PostgreSQL work order row, not from the memory text.
    assert.match(result.answer, /Current PostgreSQL work order WO-2026-004 for P-204 is OPEN/);
  });
});

test("two AGENT_RESULT anchors on different assets still fail closed", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: LATER, sessionId: "worker-ambiguous" },
      {
        client,
        retrieveContext: async () =>
          contextRetrieval([
            memoryDoc({
              memoryId: "agent-result:create_work_order:anchor-1",
              type: "AGENT_RESULT",
              score: 0.71,
              assetId: P204_ID,
              assetCode: "P-204",
              source: "workflow",
            }),
            memoryDoc({
              memoryId: "agent-result:create_work_order:anchor-2",
              type: "AGENT_RESULT",
              score: 0.68,
              assetId: M101_ID,
              assetCode: "M-101",
              source: "workflow",
            }),
          ]),
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "clarification_required");
    assert.equal(trace.assetResolution, null);
    assert.equal(state.writes, 0);
  });
});

test("without AGENT_RESULT anchors a single semantic asset still resolves as semantic memory", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: LATER, sessionId: "worker-semantic-one" },
      {
        client,
        retrieveContext: async () =>
          contextRetrieval([
            memoryDoc({ memoryId: `work-order:${P204_ID}`, type: "WORK_ORDER", score: 0.61, assetId: P204_ID, assetCode: "P-204" }),
            memoryDoc({ memoryId: `maintenance:${P204_ID}`, type: "MAINTENANCE", score: 0.52, assetId: P204_ID, assetCode: "P-204" }),
            memoryDoc({ memoryId: `sop:${P204_ID}`, type: "SOP", score: 0.31, assetId: P204_ID, assetCode: "P-204" }),
          ]),
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "completed");
    assert.equal(trace.assetResolution?.fromMemory, true);
    assert.equal(trace.assetResolution?.basis, "semantic_memory");
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(state.writes, 0);
  });
});

test("without AGENT_RESULT anchors docs spanning two assets stay clarification_required", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: LATER, sessionId: "worker-semantic-many" },
      {
        client,
        retrieveContext: async () =>
          contextRetrieval([
            memoryDoc({ memoryId: `incident:${M101_ID}`, type: "INCIDENT", score: 0.54, assetId: M101_ID, assetCode: "M-101" }),
            memoryDoc({ memoryId: `work-order:${P204_ID}`, type: "WORK_ORDER", score: 0.49, assetId: P204_ID, assetCode: "P-204" }),
          ]),
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "clarification_required");
    assert.equal(trace.assetResolution, null);
    assert.equal(state.writes, 0);
  });
});

test("an AGENT_RESULT anchor without a usable asset_id is ignored and falls back to semantic memory", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_TWO, timestamp: LATER, sessionId: "worker-bad-anchor" },
      {
        client,
        retrieveContext: async () =>
          contextRetrieval([
            memoryDoc({
              memoryId: "agent-result:create_work_order:anchor-1",
              type: "AGENT_RESULT",
              score: 0.88,
              assetCode: "P-204",
              source: "workflow",
            }),
            memoryDoc({ memoryId: `work-order:${P204_ID}`, type: "WORK_ORDER", score: 0.47, assetId: P204_ID, assetCode: "P-204" }),
          ]),
        now: () => new Date(LATER),
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "completed");
    assert.equal(trace.assetResolution?.fromMemory, true);
    assert.equal(trace.assetResolution?.basis, "semantic_memory");
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(state.writes, 0);
  });
});

test("Request 1 explicit asset reference is unchanged: creates, verifies and persists, without using memory basis", async () => {
  await withMockLyzr(async () => {
    const state = seedState();
    const { client } = fakeClient(state);

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: DEMO_ONE, timestamp: NOW.toISOString(), sessionId: "worker-explicit" },
      {
        client,
        retrieve: async () => sopRetrieval(),
        persistMemory: async (input) => {
          const memory = buildAgentResultMemory(input);
          return {
            attempted: true,
            persisted: true,
            memoryId: memory.id,
            type: "AGENT_RESULT" as const,
            collection: "fieldos-knowledge",
          };
        },
        now: () => NOW,
      }
    );

    const trace = result.workflow?.trace;
    assert.ok(trace);
    assert.equal(trace.status, "completed");
    assert.equal(trace.assetResolution?.fromMemory, false);
    assert.equal(trace.assetResolution?.basis, undefined);
    assert.equal(trace.assetResolution?.assetCode, "P-204");
    assert.equal(trace.action?.actionType, "CREATE_WORK_ORDER");
    assert.equal(trace.action?.verified, true);
    assert.equal(trace.verification?.success, true);
    assert.equal(trace.memoryPersistence?.persisted, true);
    assert.equal(stage(trace, "memory_persistence").state, "completed");
    assert.equal(state.writes, 1);
  });
});
