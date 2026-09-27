import type { ActionExecutionResult } from "../types";
import type {
  AgentMemoryInput,
  MemoryAssetRecord,
  MemoryDocument,
  MemoryIncidentRecord,
  MemoryMaintenanceRecord,
  MemoryMetadata,
  MemorySopRecord,
  MemoryWorkOrderRecord,
} from "./types";

const MAX_TEXT = 1800;

function dateText(value: Date | string | null | undefined): string {
  if (value instanceof Date) return value.toISOString();
  return value?.trim() ?? "unknown";
}

function shortText(value: string, max = MAX_TEXT): string {
  const normalized = value.trim();
  return normalized.length > max ? `${normalized.slice(0, max - 3)}...` : normalized;
}

function locationText(asset: MemoryAssetRecord): string {
  return asset.plant.location ? ` (${asset.plant.location})` : "";
}

function baseMetadata(
  type: MemoryDocument["metadata"]["type"],
  asset: MemoryAssetRecord,
  date: string,
  source: string,
  extra: Record<string, string | undefined>
): MemoryMetadata {
  return {
    type,
    plant_id: asset.plant.id,
    plant_code: asset.plant.code,
    asset_id: asset.id,
    asset_code: asset.code,
    date,
    source,
    ...extra,
  };
}

export function assetMemoryId(assetId: string): string {
  return `asset:${assetId}`;
}

export function incidentMemoryId(incidentId: string): string {
  return `incident:${incidentId}`;
}

export function maintenanceMemoryId(maintenanceId: string): string {
  return `maintenance:${maintenanceId}`;
}

export function workOrderMemoryId(workOrderId: string): string {
  return `work-order:${workOrderId}`;
}

export function sopMemoryId(sopId: string): string {
  return `sop:${sopId}`;
}

export function agentResultMemoryId(action: Pick<ActionExecutionResult, "actionType" | "id">): string {
  return `agent-result:${action.actionType.toLowerCase()}:${action.id}`;
}

export function buildIncidentMemory(record: MemoryIncidentRecord): MemoryDocument {
  const date = dateText(record.occurredAt);
  const resolution = record.resolvedAt ? dateText(record.resolvedAt) : "not resolved";
  return {
    id: incidentMemoryId(record.id),
    text: `Incident ${record.code} affected ${record.asset.name} (${record.asset.code}) at ${record.asset.plant.name}${locationText(record.asset)}. ${shortText(record.title, 500)}. ${shortText(record.description, 900)}. Root cause: ${shortText(record.rootCause, 700)}. Severity: ${record.severity}. Reported: ${date}. Resolution: ${resolution}.`,
    metadata: baseMetadata("INCIDENT", record.asset, date, "postgres", {
      incident_id: record.id,
      incident_code: record.code,
      severity: record.severity,
      status: record.resolvedAt ? "RESOLVED" : "OPEN",
    }),
  };
}

export function buildMaintenanceMemory(record: MemoryMaintenanceRecord): MemoryDocument {
  const date = dateText(record.performedAt);
  return {
    id: maintenanceMemoryId(record.id),
    text: `Maintenance ${record.code} was performed on ${record.asset.name} (${record.asset.code}) at ${record.asset.plant.name}${locationText(record.asset)}. ${shortText(record.title, 500)}. ${shortText(record.description, 900)}. Action taken: ${shortText(record.actionTaken, 700)}. Performed: ${date}.`,
    metadata: baseMetadata("MAINTENANCE", record.asset, date, "postgres", {
      maintenance_id: record.id,
      maintenance_code: record.code,
      maintenance_type: record.type,
    }),
  };
}

export function buildWorkOrderMemory(record: MemoryWorkOrderRecord): MemoryDocument {
  const date = dateText(record.createdAt);
  return {
    id: workOrderMemoryId(record.id),
    text: `Work order ${record.code} was created for ${record.asset.name} (${record.asset.code}) at ${record.asset.plant.name}${locationText(record.asset)}. ${shortText(record.title, 500)}. ${shortText(record.description, 900)}. Priority: ${record.priority}. Status: ${record.status}. Scheduled: ${dateText(record.scheduledAt)}.`,
    metadata: baseMetadata("WORK_ORDER", record.asset, date, "postgres", {
      work_order_id: record.id,
      work_order_code: record.code,
      status: record.status,
      priority: record.priority,
    }),
  };
}

export function buildSopMemory(record: MemorySopRecord): MemoryDocument {
  const date = dateText(record.createdAt);
  return {
    id: sopMemoryId(record.id),
    text: `Procedure ${record.code} for ${record.asset.name} (${record.asset.code}): ${shortText(record.title, 500)}. Category: ${record.category}. ${shortText(record.content)}`,
    metadata: baseMetadata("SOP", record.asset, date, "postgres", {
      sop_id: record.id,
      sop_code: record.code,
      category: record.category,
    }),
  };
}

export function buildAssetContextMemory(record: MemoryAssetRecord): MemoryDocument {
  const date = dateText(record.updatedAt ?? record.createdAt);
  const counts = [
    `${record.incidentCount ?? 0} incidents`,
    `${record.maintenanceCount ?? 0} maintenance records`,
    `${record.workOrderCount ?? 0} work orders`,
    `${record.sopCount ?? 0} SOPs`,
  ].join(", ");
  return {
    id: assetMemoryId(record.id),
    text: `Asset context: ${record.code} is ${record.name}, a ${record.manufacturer} ${record.model} at ${record.plant.name}${locationText(record)}. Current asset status: ${record.status}. Related records: ${counts}.`,
    metadata: baseMetadata("ASSET_CONTEXT", record, date, "postgres", {
      status: record.status,
    }),
  };
}

export function buildAgentResultMemory(input: AgentMemoryInput): MemoryDocument {
  const { input: normalized, asset, investigation, action, verification } = input;
  const memoryId = agentResultMemoryId(action);
  const findings = shortText(investigation.findings.join(" "), 1000);
  const transcript = shortText(normalized.transcript, 1000);
  const actionEntityId =
    action.entity === "work_order"
      ? { work_order_id: action.id }
      : action.entity === "incident"
        ? { incident_id: action.id }
        : { maintenance_id: action.id };
  const optionalDetails = {
    status: typeof action.details.status === "string" ? action.details.status : undefined,
    priority: typeof action.details.priority === "string" ? action.details.priority : undefined,
    severity: typeof action.details.severity === "string" ? action.details.severity : undefined,
  };
  return {
    id: memoryId,
    text: `Field worker reported: ${transcript} Investigation findings: ${findings}. Action completed: ${action.actionType} ${action.code} for ${asset.name} (${asset.code}). Verification: ${shortText(verification.summary, 600)}.`,
    metadata: baseMetadata("AGENT_RESULT", asset, normalized.timestamp, "workflow", {
      workflow_id: memoryId,
      workflowId: memoryId,
      action_type: action.actionType,
      action_code: action.code,
      input_source: normalized.source,
      ...(normalized.sessionId ? { session_id: normalized.sessionId } : {}),
      ...actionEntityId,
      ...optionalDetails,
    }),
  };
}
