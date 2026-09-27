import type {
  ActionExecutionResult,
  InvestigationResult,
  NormalizedInvestigationInput,
  TriageResult,
  VerificationResult,
  MemoryPersistenceStatus,
  MemoryType,
} from "../types";

export type { MemoryPersistenceStatus, MemoryType } from "../types";

export interface MemoryAssetContext {
  id: string;
  code: string;
  name: string;
  manufacturer: string;
  model: string;
  status: string;
  plant: {
    id: string;
    code: string;
    name: string;
    location: string | null;
  };
  createdAt?: Date;
  updatedAt?: Date;
  incidentCount?: number;
  maintenanceCount?: number;
  workOrderCount?: number;
  sopCount?: number;
}

export type MemoryAssetRecord = MemoryAssetContext;

export interface MemoryIncidentRecord {
  id: string;
  code: string;
  title: string;
  description: string;
  rootCause: string;
  severity: string;
  occurredAt: Date;
  resolvedAt: Date | null;
  asset: MemoryAssetRecord;
}

export interface MemoryMaintenanceRecord {
  id: string;
  code: string;
  type: string;
  title: string;
  description: string;
  actionTaken: string;
  performedAt: Date;
  asset: MemoryAssetRecord;
}

export interface MemoryWorkOrderRecord {
  id: string;
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  scheduledAt: Date;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  asset: MemoryAssetRecord;
}

export interface MemorySopRecord {
  id: string;
  code: string;
  title: string;
  category: string;
  content: string;
  createdAt: Date;
  asset: MemoryAssetRecord;
}

export type MemoryMetadata = Readonly<Record<string, string | undefined>> & {
  type: MemoryType;
  plant_id: string;
  asset_id: string;
  date: string;
  source: string;
};

export interface MemoryDocument {
  id: string;
  text: string;
  metadata: MemoryMetadata;
}

export interface AgentMemoryInput {
  input: NormalizedInvestigationInput;
  asset: MemoryAssetContext;
  triage: TriageResult;
  investigation: InvestigationResult;
  action: ActionExecutionResult;
  verification: VerificationResult;
}

