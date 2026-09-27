import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { PipeError, type ActionEntity, type ActionExecutionResult } from "../types";
import { parseActionRequest, type ActionRequest } from "./validation";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITY_ORDER = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 } as const;

export interface ActionContext {
  client?: PrismaClient;
  now?: () => Date;
  expectedAssetId?: string;
}

type AssetRecord = { id: string; code: string };
type TechnicianRecord = { id: string; code: string };

type WorkOrderRecord = {
  id: string;
  code: string;
  assetId: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  scheduledAt: Date;
  completedAt: Date | null;
  updatedAt?: Date;
  technicianId: string;
};

type IncidentRecord = {
  id: string;
  code: string;
  assetId: string;
  title: string;
  description: string;
  rootCause: string;
  severity: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  technicianId: string;
  updatedAt?: Date;
};

type MaintenanceRecord = {
  id: string;
  code: string;
  assetId: string;
  title: string;
  description: string;
  actionTaken: string;
  type: string;
  performedAt: Date;
  technicianId: string;
};

function databaseClient(context: ActionContext): PrismaClient {
  return context.client ?? prisma;
}

function currentTime(context: ActionContext): Date {
  return context.now?.() ?? new Date();
}

function identifier(value: string): string {
  return value.trim();
}

async function findAsset(client: PrismaClient, value: string): Promise<AssetRecord | null> {
  const normalized = identifier(value);
  if (!normalized) return null;

  const byCode = await client.asset.findUnique({ where: { code: normalized } });
  if (byCode) return byCode;

  if (!UUID_PATTERN.test(normalized) && normalized !== normalized.toUpperCase()) {
    const byUpperCode = await client.asset.findUnique({ where: { code: normalized.toUpperCase() } });
    if (byUpperCode) return byUpperCode;
  }

  if (UUID_PATTERN.test(normalized)) {
    return client.asset.findUnique({ where: { id: normalized } });
  }

  return null;
}

async function requireAsset(client: PrismaClient, value: string): Promise<AssetRecord> {
  const asset = await findAsset(client, value);
  if (!asset) {
    throw new PipeError("invalid_request", 400, "The referenced asset could not be resolved.");
  }
  return asset;
}

async function findTechnician(
  client: PrismaClient,
  value: string
): Promise<TechnicianRecord | null> {
  const normalized = identifier(value);
  if (!normalized) return null;

  const byCode = await client.technician.findUnique({ where: { code: normalized } });
  if (byCode) return byCode;

  if (!UUID_PATTERN.test(normalized) && normalized !== normalized.toUpperCase()) {
    const byUpperCode = await client.technician.findUnique({ where: { code: normalized.toUpperCase() } });
    if (byUpperCode) return byUpperCode;
  }

  if (UUID_PATTERN.test(normalized)) {
    return client.technician.findUnique({ where: { id: normalized } });
  }

  return null;
}

async function requireTechnicianRecord(
  client: PrismaClient,
  technicianId: string
): Promise<TechnicianRecord> {
  const technician = await client.technician.findUnique({ where: { id: technicianId } });
  if (!technician) {
    throw new PipeError("invalid_request", 400, "The assigned technician could not be resolved.");
  }
  return technician;
}

async function resolveTechnician(
  client: PrismaClient,
  assetId: string,
  requestedIdentifier?: string
): Promise<TechnicianRecord> {
  if (requestedIdentifier) {
    const technician = await findTechnician(client, requestedIdentifier);
    if (!technician) {
      throw new PipeError("invalid_request", 400, "The referenced technician could not be resolved.");
    }
    return technician;
  }

  const openWorkOrder = await client.workOrder.findFirst({
    where: { assetId, status: "OPEN" },
    orderBy: { updatedAt: "desc" },
    select: { technicianId: true },
  });
  if (openWorkOrder) return requireTechnicianRecord(client, openWorkOrder.technicianId);

  const recentWorkOrder = await client.workOrder.findFirst({
    where: { assetId },
    orderBy: { updatedAt: "desc" },
    select: { technicianId: true },
  });
  if (recentWorkOrder) return requireTechnicianRecord(client, recentWorkOrder.technicianId);

  const recentIncident = await client.incident.findFirst({
    where: { assetId },
    orderBy: { updatedAt: "desc" },
    select: { technicianId: true },
  });
  if (recentIncident) return requireTechnicianRecord(client, recentIncident.technicianId);

  throw new PipeError(
    "invalid_request",
    400,
    "No technician assignment is available for this asset; provide a valid technicianId."
  );
}

function generatedCode(prefix: string, assetCode: string, seed: string): string {
  const safeAssetCode = assetCode.replace(/[^a-z0-9]/gi, "").slice(0, 20).toUpperCase();
  const suffix = createHash("sha256").update(seed).digest("hex").slice(0, 10).toUpperCase();
  return `${prefix}-${safeAssetCode}-${suffix}`;
}

function assertExpectedAsset(context: ActionContext, asset: AssetRecord): void {
  if (context.expectedAssetId && context.expectedAssetId !== asset.id) {
    throw new PipeError("invalid_request", 400, "The action does not target the resolved asset.");
  }
}

function detailValue(value: unknown): string | number | boolean | null {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return JSON.stringify(value);
}

function result(
  actionType: ActionRequest["type"],
  entity: ActionEntity,
  record: { id: string; code: string; assetId: string },
  asset: AssetRecord,
  summary: string,
  details: Record<string, unknown> = {}
): ActionExecutionResult {
  const serializedDetails: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) serializedDetails[key] = detailValue(value);
  return {
    actionType,
    entity,
    id: record.id,
    code: record.code,
    assetId: asset.id,
    assetCode: asset.code,
    summary,
    details: serializedDetails,
  };
}

async function findWorkOrder(
  client: PrismaClient,
  request: Extract<ActionRequest, { type: "UPDATE_WORK_ORDER" }>
): Promise<WorkOrderRecord> {
  if (request.workOrderId) {
    if (!UUID_PATTERN.test(request.workOrderId)) {
      throw new PipeError("invalid_request", 400, "workOrderId must be a valid UUID.");
    }
    const workOrder = await client.workOrder.findUnique({ where: { id: request.workOrderId } });
    if (!workOrder) throw new PipeError("invalid_request", 400, "The work order could not be found.");
    return workOrder;
  }

  const workOrder = await client.workOrder.findUnique({ where: { code: request.workOrderCode! } });
  if (!workOrder) throw new PipeError("invalid_request", 400, "The work order could not be found.");
  return workOrder;
}

async function findIncident(
  client: PrismaClient,
  request: Extract<ActionRequest, { type: "ESCALATE_INCIDENT" }>
): Promise<IncidentRecord> {
  if (request.incidentId) {
    if (!UUID_PATTERN.test(request.incidentId)) {
      throw new PipeError("invalid_request", 400, "incidentId must be a valid UUID.");
    }
    const incident = await client.incident.findUnique({ where: { id: request.incidentId } });
    if (!incident) throw new PipeError("invalid_request", 400, "The incident could not be found.");
    return incident;
  }

  const incident = await client.incident.findUnique({ where: { code: request.incidentCode! } });
  if (!incident) throw new PipeError("invalid_request", 400, "The incident could not be found.");
  return incident;
}

export async function createWorkOrder(
  request: Extract<ActionRequest, { type: "CREATE_WORK_ORDER" }>,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);
  if (parsed.type !== "CREATE_WORK_ORDER") {
    throw new PipeError("invalid_request", 400, "The action type does not match createWorkOrder.");
  }
  request = parsed;
  const client = databaseClient(context);
  const now = currentTime(context);
  const asset = await requireAsset(client, request.assetId);
  assertExpectedAsset(context, asset);
  const technician = await resolveTechnician(client, asset.id, request.technicianId);
  const code =
    request.code ??
    generatedCode(
      "WO",
       asset.code,
       `${asset.code}|${request.title}|${request.description}|${request.reason}|${request.scheduledAt?.toISOString() ?? ""}`
     );
  const status = request.status ?? "OPEN";

  const completedAt =
    request.completedAt !== undefined
      ? request.completedAt
      : status === "COMPLETED"
        ? now
        : null;
  if (status === "COMPLETED" && completedAt === null) {
    throw new PipeError("invalid_request", 400, "A completed work order requires completedAt.");
  }
  if (status !== "COMPLETED" && completedAt !== null) {
    throw new PipeError("invalid_request", 400, "Only completed work orders may have completedAt.");
  }

  const workOrder = await client.workOrder.create({
    data: {
      code,
      assetId: asset.id,
      title: request.title,
      description: request.description,
      priority: request.priority,
      status,
      scheduledAt: request.scheduledAt ?? now,
      completedAt,
      technicianId: technician.id,
    },
  });

  return result("CREATE_WORK_ORDER", "work_order", workOrder, asset, "Work order created.", {
    title: workOrder.title,
    description: workOrder.description,
    status: workOrder.status,
    priority: workOrder.priority,
    scheduledAt: workOrder.scheduledAt,
    completedAt: workOrder.completedAt,
    technicianId: technician.id,
    technicianCode: technician.code,
  });
}

export async function updateWorkOrder(
  request: Extract<ActionRequest, { type: "UPDATE_WORK_ORDER" }>,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);
  if (parsed.type !== "UPDATE_WORK_ORDER") {
    throw new PipeError("invalid_request", 400, "The action type does not match updateWorkOrder.");
  }
  request = parsed;
  const client = databaseClient(context);
  const current = await findWorkOrder(client, request);
  if (context.expectedAssetId && current.assetId !== context.expectedAssetId) {
    throw new PipeError("invalid_request", 400, "The work order does not belong to the resolved asset.");
  }
  const asset = request.assetId
    ? await requireAsset(client, request.assetId)
    : await requireAsset(client, current.assetId);
  assertExpectedAsset(context, asset);
  const technician = request.technicianId
    ? await resolveTechnician(client, asset.id, request.technicianId)
    : null;
  const nextStatus = request.status ?? current.status;
  const nextCompletedAt = request.completedAt !== undefined ? request.completedAt : current.completedAt;
  if (nextStatus === "COMPLETED" && nextCompletedAt === null) {
    throw new PipeError("invalid_request", 400, "A completed work order requires completedAt.");
  }
  if (nextStatus !== "COMPLETED" && nextCompletedAt !== null) {
    throw new PipeError("invalid_request", 400, "Only completed work orders may have completedAt.");
  }

  const data: {
    assetId?: string;
    title?: string;
    description?: string;
    priority?: string;
    status?: string;
    scheduledAt?: Date;
    completedAt?: Date | null;
    technicianId?: string;
  } = {};

  if (request.assetId) data.assetId = asset.id;
  if (request.title !== undefined) data.title = request.title;
  if (request.description !== undefined) data.description = request.description;
  if (request.priority !== undefined) data.priority = request.priority;
  if (request.status !== undefined) data.status = request.status;
  if (request.scheduledAt !== undefined) data.scheduledAt = request.scheduledAt;
  if (request.completedAt !== undefined) data.completedAt = request.completedAt;
  if (technician) data.technicianId = technician.id;

  const workOrder = await client.workOrder.update({
    where: { id: current.id },
    data,
  });

  return result("UPDATE_WORK_ORDER", "work_order", workOrder, asset, "Work order updated.", {
    title: workOrder.title,
    description: workOrder.description,
    previousStatus: current.status,
    status: workOrder.status,
    previousPriority: current.priority,
    priority: workOrder.priority,
    scheduledAt: workOrder.scheduledAt,
    completedAt: workOrder.completedAt,
    technicianId: workOrder.technicianId,
  });
}

export async function createIncident(
  request: Extract<ActionRequest, { type: "CREATE_INCIDENT" }>,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);
  if (parsed.type !== "CREATE_INCIDENT") {
    throw new PipeError("invalid_request", 400, "The action type does not match createIncident.");
  }
  request = parsed;
  const client = databaseClient(context);
  const now = currentTime(context);
  const asset = await requireAsset(client, request.assetId);
  assertExpectedAsset(context, asset);
  const technician = await resolveTechnician(client, asset.id, request.technicianId);
  const code =
    request.code ??
    generatedCode(
       "INC",
       asset.code,
       `${asset.code}|${request.title}|${request.description}|${request.reason}|${request.occurredAt?.toISOString() ?? ""}`
     );


  const incident = await client.incident.create({
    data: {
      code,
      assetId: asset.id,
      title: request.title,
      description: request.description,
      rootCause: request.rootCause,
      severity: request.severity,
      occurredAt: request.occurredAt ?? now,
      resolvedAt: request.resolvedAt ?? null,
      technicianId: technician.id,
    },
  });

  return result("CREATE_INCIDENT", "incident", incident, asset, "Incident created.", {
    title: incident.title,
    description: incident.description,
    rootCause: incident.rootCause,
    severity: incident.severity,
    occurredAt: incident.occurredAt,
    resolvedAt: incident.resolvedAt,
    technicianId: technician.id,
    technicianCode: technician.code,
  });
}

export async function recordObservation(
  request: Extract<ActionRequest, { type: "RECORD_OBSERVATION" }>,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);
  if (parsed.type !== "RECORD_OBSERVATION") {
    throw new PipeError("invalid_request", 400, "The action type does not match recordObservation.");
  }
  request = parsed;
  const client = databaseClient(context);
  const now = currentTime(context);
  const asset = await requireAsset(client, request.assetId);
  assertExpectedAsset(context, asset);
  const technician = await resolveTechnician(client, asset.id, request.technicianId);
  const code =
    request.code ??
    generatedCode(
       "OBS",
       asset.code,
       `${asset.code}|${request.title}|${request.description}|${request.reason}|${request.performedAt?.toISOString() ?? ""}`

    );
  const actionTaken = request.actionTaken ?? "Observation recorded; no corrective action was performed.";

  const record = await client.maintenanceRecord.create({
    data: {
      code,
      assetId: asset.id,
      type: "OBSERVATION",
      title: request.title,
      description: request.description,
      actionTaken,
      performedAt: request.performedAt ?? now,
      technicianId: technician.id,
    },
  });

  return result("RECORD_OBSERVATION", "maintenance_record", record, asset, "Observation recorded.", {
    title: record.title,
    description: record.description,
    actionTaken: record.actionTaken,
    type: record.type,
    performedAt: record.performedAt,
    technicianId: technician.id,
    technicianCode: technician.code,
  });
}

export async function escalateIncident(
  request: Extract<ActionRequest, { type: "ESCALATE_INCIDENT" }>,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);
  if (parsed.type !== "ESCALATE_INCIDENT") {
    throw new PipeError("invalid_request", 400, "The action type does not match escalateIncident.");
  }
  request = parsed;
  const client = databaseClient(context);
  const incident = await findIncident(client, request);
  if (context.expectedAssetId && incident.assetId !== context.expectedAssetId) {
    throw new PipeError("invalid_request", 400, "The incident does not belong to the resolved asset.");
  }
  const previousSeverity = incident.severity.toUpperCase() as keyof typeof PRIORITY_ORDER;
  const nextSeverity = request.severity;
  if (!(previousSeverity in PRIORITY_ORDER) || PRIORITY_ORDER[previousSeverity] >= PRIORITY_ORDER[nextSeverity]) {
    throw new PipeError("invalid_request", 400, "Incident escalation must increase severity.");
  }

  const asset = await requireAsset(client, incident.assetId);
  assertExpectedAsset(context, asset);
  const updateResult = await client.incident.updateMany({
    where: { id: incident.id, severity: previousSeverity },
    data: { severity: nextSeverity },
  });
  if (updateResult.count !== 1) {
    throw new PipeError("invalid_request", 400, "Incident severity changed concurrently; escalation was not applied.");
  }
  const updated = await client.incident.findUnique({ where: { id: incident.id } });
  if (!updated) throw new PipeError("invalid_request", 400, "The incident could not be re-read after escalation.");

  return result("ESCALATE_INCIDENT", "incident", updated, asset, "Incident escalated.", {
    previousSeverity,
    severity: updated.severity,
  });
}

async function withActionErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof PipeError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "P2002") {
      throw new PipeError("invalid_request", 400, "The requested action would create a duplicate record.");
    }
    if (code === "P2025") {
      throw new PipeError("invalid_request", 400, "The requested record no longer exists.");
    }
    throw new PipeError("database", 500, "The requested action could not be completed.");
  }
}

export async function executeActionRequest(
  request: ActionRequest,
  context: ActionContext = {}
): Promise<ActionExecutionResult> {
  const parsed = parseActionRequest(request);

  return withActionErrors(() => {
    switch (parsed.type) {
      case "CREATE_WORK_ORDER":
        return createWorkOrder(parsed, context);
      case "UPDATE_WORK_ORDER":
        return updateWorkOrder(parsed, context);
      case "CREATE_INCIDENT":
        return createIncident(parsed, context);
      case "RECORD_OBSERVATION":
        return recordObservation(parsed, context);
      case "ESCALATE_INCIDENT":
        return escalateIncident(parsed, context);
    }
  });
}
