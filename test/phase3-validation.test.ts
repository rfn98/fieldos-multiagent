import test from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { executeActionRequest } from "../lib/actions";
import { parseActionRequest } from "../lib/actions/validation";
import { PipeError } from "../lib/types";
import { buildAgentResultMemory } from "../lib/memory/builders";
import type { QdrantDocument } from "../lib/qdrant/retrieval";
import { runInvestigationWorkflow } from "../lib/workflow/orchestrator";

const NOW = new Date("2026-09-25T10:00:00.000Z");

interface FakeState {
  workOrders: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  maintenanceRecords: Array<Record<string, unknown>>;
  writes: number;
  failedReadBackIds: Set<string>;
  workOrderReadBack: ((record: Record<string, unknown>) => Record<string, unknown>) | null;
}

function createFakeClient() {
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
  const incident = {
    id: "incident-1",
    code: "INC-2026-002",
    assetId: asset.id,
    title: "Unexpected pump shutdown",
    description: "P-204 unexpectedly shut down.",
    rootCause: "Heavy intake filter contamination.",
    severity: "CRITICAL",
    occurredAt: NOW,
    resolvedAt: NOW,
    technicianId: technician.id,
    createdAt: NOW,
    updatedAt: NOW,
    technician,
  };
  asset.workOrders.push(openWorkOrder);
  asset.incidents.push(incident);
  const state: FakeState = {
    workOrders: [openWorkOrder],
    incidents: [incident],
    maintenanceRecords: [],
    writes: 0,
    failedReadBackIds: new Set<string>(),
    workOrderReadBack: null,
  };

  const client = {
    asset: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id?.toLowerCase() === asset.id.toLowerCase() || where.code === asset.code) return asset;
        return null;
      },
    },
    technician: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id === technician.id || where.code === technician.code) return technician;
        return null;
      },
    },
    workOrder: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id && state.failedReadBackIds.has(where.id)) return null;
        const record =
          state.workOrders.find((item) => item.id === where.id || item.code === where.code) ?? null;
        return record && state.workOrderReadBack ? state.workOrderReadBack(record) : record;
      },
      findFirst: async ({ where }: { where: { assetId?: string; status?: string } }) => {
        return (
          state.workOrders.find(
            (record) =>
              (!where.assetId || record.assetId === where.assetId) &&
              (!where.status || record.status === where.status)
          ) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = {
          id: `wo-${state.workOrders.length + 1}`,
          createdAt: NOW,
          updatedAt: NOW,
          technician,
          ...data,
        };
        state.workOrders.push(record);
        asset.workOrders.push(record);
        state.writes += 1;
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = state.workOrders.find((item) => item.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data, { updatedAt: NOW });
        state.writes += 1;
        return record;
      },
    },
    incident: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        return state.incidents.find((record) => record.id === where.id || record.code === where.code) ?? null;
      },
      findFirst: async ({ where }: { where: { assetId?: string } }) => {
        return state.incidents.find((record) => !where.assetId || record.assetId === where.assetId) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `incident-${state.incidents.length + 1}`, createdAt: NOW, updatedAt: NOW, ...data };
        state.incidents.push(record);
        state.writes += 1;
        return record;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const record = state.incidents.find((item) => item.id === where.id);
        if (!record) throw new Error("not found");
        Object.assign(record, data, { updatedAt: NOW });
        state.writes += 1;
        return record;
      },
      updateMany: async ({ where, data }: { where: { id: string; severity: string }; data: Record<string, unknown> }) => {
        const record = state.incidents.find((item) => item.id === where.id && item.severity === where.severity);
        if (!record) return { count: 0 };
        Object.assign(record, data, { updatedAt: NOW });
        state.writes += 1;
        return { count: 1 };
      },
    },
    maintenanceRecord: {
      findUnique: async ({ where }: { where: { id?: string; code?: string } }) => {
        return (
          state.maintenanceRecords.find((record) => record.id === where.id || record.code === where.code) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const record = { id: `observation-${state.maintenanceRecords.length + 1}`, createdAt: NOW, updatedAt: NOW, ...data };
        state.maintenanceRecords.push(record);
        state.writes += 1;
        return record;
      },
    },
  };

  return { client: client as unknown as PrismaClient, state, asset };
}

function retrieval() {
  return {
    docs: [
      {
        id: "SOP-014",
        text: "P-204 intake filter inspection procedure. Inspect contamination and verify vibration after restart.",
        content: "P-204 intake filter inspection procedure. Inspect contamination and verify vibration after restart.",
        memoryId: "SOP-014",
        score: 0.97,
        metadata: {
          type: "sop",
          asset_id: "P-204",
          plant_id: "PLANT-A",
          category: "INSPECTION",
          source: "postgres",
        },
      },
    ],
    latencyMs: 2,
    collectionName: "fieldos-knowledge",
    query: "P-204 abnormal vibration",
  };
}

test("P-204 mock workflow resolves the asset and creates a verified work order", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204. The pump is making abnormal vibration and needs a follow-up inspection.",
        timestamp: "2026-09-25T10:00:00.000Z",
        sessionId: "demo-session",
      },
      { client, retrieve: async () => retrieval(), now: () => NOW }
    );

    assert.equal(result.workflow?.status, "completed");
    assert.equal(result.workflow?.action?.entity, "work_order");
    assert.equal(result.workflow?.action?.assetCode, "P-204");
    assert.equal(result.workflow?.verification?.success, true);
    assert.equal(result.workflow?.actionRequest?.type, "CREATE_WORK_ORDER");
    assert.equal(state.writes, 1);
    assert.equal(state.workOrders.length, 2);
    assert.match(String(state.workOrders[1].code), /^WO-P204-[A-F0-9]{10}$/);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("verification fails when the written record cannot be read back", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  state.failedReadBackIds.add("wo-2");

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204 is making abnormal vibration and needs a follow-up inspection.",
        timestamp: NOW.toISOString(),
      },
      { client, retrieve: async () => retrieval(), now: () => NOW }
    );

    assert.equal(result.workflow?.status, "failed");
    assert.equal(result.workflow?.action?.code !== undefined, true);
    assert.equal(result.workflow?.verification?.success, false);
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("verification rejects a persisted field mismatch", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  state.workOrderReadBack = (record) => ({ ...record, title: "Persisted title mismatch" });

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204 is making abnormal vibration and needs a follow-up inspection.",
        timestamp: NOW.toISOString(),
      },
      { client, retrieve: async () => retrieval(), now: () => NOW }
    );

    assert.equal(result.workflow?.status, "failed");
    assert.equal(result.workflow?.verification?.success, false);
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("asset-like prefixes and malformed suffixes do not resolve as the base asset", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  let retrievalCalled = false;

  try {
    for (const transcript of [
      "P-204-004 is making abnormal vibration.",
      "P-204._004 is making abnormal vibration.",
      "P-204./004 is making abnormal vibration.",
      "P-204.-004 is making abnormal vibration.",
      "P-204.004 is making abnormal vibration.",
      "P-204... is making abnormal vibration.",
    ]) {
      const result = await runInvestigationWorkflow(
        { source: "omi", transcript, timestamp: NOW.toISOString() },
        {
          client,
          retrieve: async () => {
            retrievalCalled = true;
            return retrieval();
          },
        }
      );

      assert.equal(result.workflow?.status, "clarification_required", transcript);
      assert.equal(retrievalCalled, false, transcript);
    }
    assert.equal(state.writes, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("prefixed asset-like tokens do not resolve as the base asset", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  let retrievalCalled = false;

  try {
    const result = await runInvestigationWorkflow(
      { source: "omi", transcript: "foo.P-204 is making abnormal vibration.", timestamp: NOW.toISOString() },
      {
        client,
        retrieve: async () => {
          retrievalCalled = true;
          return retrieval();
        },
      }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(retrievalCalled, false);
    assert.equal(state.writes, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("one unresolved reference prevents action even when another asset is valid", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  let retrievalCalled = false;

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "omi",
        transcript: "P-204 and P-999 are making abnormal vibration.",
        timestamp: NOW.toISOString(),
      },
      {
        client,
        retrieve: async () => {
          retrievalCalled = true;
          return retrieval();
        },
      }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(retrievalCalled, false);
    assert.equal(state.writes, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("metadata-only asset references use the same mock workflow", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "omi",
        transcript: "The pump is making abnormal vibration and needs a follow-up inspection.",
        metadata: { assetCode: "p-204" },
        timestamp: NOW.toISOString(),
      },
      { client, retrieve: async () => retrieval(), now: () => NOW }
    );

    assert.equal(result.workflow?.status, "completed");
    assert.equal(result.workflow?.action?.assetCode, "P-204");
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("UUID asset references resolve through the same explicit-reference guard", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state, asset } = createFakeClient();

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "omi",
        transcript: `${asset.id.toUpperCase()} is making abnormal vibration and needs a follow-up inspection.`,
        timestamp: NOW.toISOString(),
      },
      { client, retrieve: async () => retrieval(), now: () => NOW }
    );

    assert.equal(result.workflow?.status, "completed");
    assert.equal(result.workflow?.action?.assetCode, "P-204");
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("unresolved assets stop before retrieval or mutation", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();
  let retrievalCalled = false;

  try {
    const result = await runInvestigationWorkflow(
      { source: "omi", transcript: "The pump is making abnormal vibration.", timestamp: NOW.toISOString() },
      {
        client,
        retrieve: async () => {
          retrievalCalled = true;
          return retrieval();
        },
      }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(result.workflow?.action, null);
    assert.equal(retrievalCalled, false);
    assert.equal(state.writes, 0);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("triage clarification short-circuits before retrieval or mutation", async () => {
  const environmentNames = [
    "LYZR_PROVIDER",
    "LYZR_API_BASE_URL",
    "LYZR_API_KEY",
    "LYZR_USER_ID",
    "LYZR_SESSION_ID",
    "LYZR_TRIAGE_AGENT_ID",
  ] as const;
  const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;

  try {
    process.env.LYZR_PROVIDER = "lyzr";
    process.env.LYZR_API_BASE_URL = "https://lyzr.test";
    process.env.LYZR_API_KEY = "test-key";
    process.env.LYZR_USER_ID = "test-user";
    process.env.LYZR_SESSION_ID = "test-session";
    process.env.LYZR_TRIAGE_AGENT_ID = "test-triage-agent";
    globalThis.fetch = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
      if (url.startsWith("https://lyzr.test")) fetchCalls += 1;
      return new Response(
        JSON.stringify({
          response: JSON.stringify({
            intent: "REQUEST_INFORMATION",
            assetId: null,
            plantId: null,
            issue: null,
            severity: null,
            requiresInvestigation: false,
            clarification: "Please provide the asset code and the field condition.",
          }),
        }),
        { status: 200 }
      );
    }) as typeof fetch;
    const { client, state } = createFakeClient();

    const result = await runInvestigationWorkflow(
      { source: "web", transcript: "I need help with a field report.", timestamp: NOW.toISOString() },
      { client }
    );

    assert.equal(result.workflow?.status, "clarification_required");
    assert.equal(result.answer, "Please provide the asset code and the field condition.");
    assert.equal(fetchCalls, 1);
    assert.equal(state.writes, 0);
  } finally {
    globalThis.fetch = previousFetch;
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("invalid action output is rejected before any Prisma write", async () => {
  const { client, state } = createFakeClient();
  const invalid = {
    type: "CREATE_WORK_ORDER",
    assetId: "P-204",
    title: "Unsafe action",
    description: "This contains an unsupported field.",
    reason: "test",
    priority: "HIGH",
    arbitraryDatabaseInstruction: "DROP TABLE work_orders",
  };

  await assert.rejects(
    () => executeActionRequest(invalid as never, { client }),
    (error: unknown) => error instanceof PipeError && error.status === 400
  );
  assert.equal(state.writes, 0);
});

test("work-order state invariants reject completed records without a timestamp", async () => {
  const { client, state } = createFakeClient();

  await assert.rejects(
    () =>
      executeActionRequest(
        {
          type: "CREATE_WORK_ORDER",
          assetId: "P-204",
          title: "Invalid completed work order",
          description: "The timestamp is intentionally missing.",
          reason: "Validation test.",
          priority: "HIGH",
          status: "COMPLETED",
          completedAt: null,
          technicianId: "TECH-001",
        },
        { client, now: () => NOW }
      ),
    (error: unknown) => error instanceof PipeError && error.status === 400
  );
  assert.equal(state.writes, 0);
});

test("observations use the existing maintenance record model without schema changes", async () => {
  const { client, state } = createFakeClient();
  const action = await executeActionRequest(
    {
      type: "RECORD_OBSERVATION",
      assetId: "P-204",
      title: "Field observation",
      description: "Operator observed abnormal vibration.",
      reason: "Preserve the field observation.",
      technicianId: "TECH-001",
      performedAt: NOW,
    },
    { client, now: () => NOW }
  );

  assert.equal(action.entity, "maintenance_record");
  assert.equal(state.maintenanceRecords.length, 1);
  assert.equal(state.maintenanceRecords[0].type, "OBSERVATION");
});

test("action validation accepts the constrained create-work-order shape", () => {
  const parsed = parseActionRequest({
    type: "CREATE_WORK_ORDER",
    assetId: "P-204",
    title: "Inspect P-204",
    description: "Inspect the intake filter.",
    reason: "A field report requires follow-up.",
    priority: "HIGH",
  });

  assert.equal(parsed.type, "CREATE_WORK_ORDER");
  assert.equal(parsed.priority, "HIGH");
});

test("Qdrant memory failure is nonfatal after a successful action", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state } = createFakeClient();

  try {
    const result = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204 is making abnormal vibration and needs a follow-up inspection.",
        timestamp: NOW.toISOString(),
      },
      {
        client,
        retrieve: async () => retrieval(),
        persistMemory: async () => ({
          attempted: true,
          persisted: false,
          error: "Qdrant unavailable",
        }),
      }
    );

    assert.equal(result.workflow?.status, "completed");
    assert.equal(result.workflow?.verification?.success, true);
    assert.equal(result.workflow?.action?.entity, "work_order");
    assert.deepEqual(result.workflow?.memoryPersistence, {
      attempted: true,
      persisted: false,
      error: "Qdrant unavailable",
    });
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});

test("a later worker request retrieves agent-result memory without a duplicate write", async () => {
  const previousProvider = process.env.LYZR_PROVIDER;
  process.env.LYZR_PROVIDER = "mock";
  const { client, state, asset } = createFakeClient();
  let memoryDoc: QdrantDocument | null = null;

  try {
    const first = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "P-204 is making abnormal vibration and needs a follow-up inspection.",
        timestamp: NOW.toISOString(),
        sessionId: "worker-1",
      },
      {
        client,
        retrieve: async () => retrieval(),
        persistMemory: async (input) => {
          const memory = buildAgentResultMemory(input);
          memoryDoc = {
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
              asset_id: input.asset.id,
              plant_id: input.asset.plant.id,
              source: memory.metadata.source,
            },
          };
          return {
            attempted: true,
            persisted: true,
            memoryId: memory.id,
            type: "AGENT_RESULT",
            collection: "fieldos-knowledge",
          };
        },
      }
    );

    assert.equal(first.workflow?.memoryPersistence?.persisted, true);
    assert.ok(memoryDoc);
    const storedMemory = memoryDoc as QdrantDocument;

    const latest = state.workOrders[state.workOrders.length - 1];
    latest.status = "COMPLETED";
    latest.completedAt = NOW;
    latest.updatedAt = new Date("2026-09-26T10:00:00.000Z");
    asset.workOrders.sort(
      (left, right) => new Date(right.updatedAt as string).getTime() - new Date(left.updatedAt as string).getTime()
    );

    const second = await runInvestigationWorkflow(
      {
        source: "web",
        transcript: "What's the status of the pump I reported yesterday?",
        timestamp: "2026-09-26T11:00:00.000Z",
        sessionId: "worker-2",
      },
      {
        client,
        retrieveContext: async () => ({ ...retrieval(), docs: [storedMemory] }),
        retrieve: async () => ({ ...retrieval(), docs: [storedMemory] }),
      }
    );

    assert.equal(second.workflow?.status, "completed");
    assert.equal(second.workflow?.action, null);
    assert.equal(second.retrieval.documents, 1);
    assert.equal(second.evidence[0]?.id, storedMemory.id);
    assert.match(second.answer, /COMPLETED/);
    assert.equal(state.writes, 1);
  } finally {
    if (previousProvider === undefined) delete process.env.LYZR_PROVIDER;
    else process.env.LYZR_PROVIDER = previousProvider;
  }
});
