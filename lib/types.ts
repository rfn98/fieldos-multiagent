import type { ActionRequest } from "./actions/validation";

export type PipeErrorKind =
  | "invalid_request"
  | "database"
  | "moss_config"
  | "moss_retrieval"
  | "qdrant_config"
  | "qdrant_request"
  | "lyzr_config"
  | "lyzr_request"
  | "lyzr_malformed"
  | "omi_config"
  | "omi_request"
  | "llm_config"
  | "llm_request"
  | "llm_malformed"
  | "internal";

export class PipeError extends Error {
  readonly kind: PipeErrorKind;
  readonly status: number;
  /**
   * Provider telemetry for a call that completed before the failure. Present only
   * when the agent actually reached its provider, so an agent that ran and then
   * produced unusable output is reported as attempted-and-failed instead of being
   * reconstructed as a step that never ran.
   */
  readonly agentTrace?: AgentStepTrace;

  constructor(
    kind: PipeErrorKind,
    status: number,
    message: string,
    agentTrace?: AgentStepTrace
  ) {
    super(message);
    this.name = "PipeError";
    this.kind = kind;
    this.status = status;
    if (agentTrace) this.agentTrace = agentTrace;
  }
}

export interface Evidence {
  id: string;
  type: string;
  assetId: string;
  score: number;
  snippet: string;
  plantId?: string;
  severity?: string;
  category?: string;
  date?: string;
}

export interface RetrievalInfo {
  provider: "moss" | "qdrant";
  indexName: string;
  latencyMs: number | null;
  documents: number;
  query: string;
  collectionName?: string;
}

export type InvestigationSource = "omi" | "web";
export type TriageIntent = "REPORT_ISSUE" | "CHECK_STATUS" | "REQUEST_INFORMATION";
export type TriageSeverity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type InvestigationAction =
  | "CREATE_WORK_ORDER"
  | "UPDATE_WORK_ORDER"
  | "ESCALATE_INCIDENT"
  | "RECORD_OBSERVATION"
  | "NO_ACTION";

/**
 * Why an effective action recommendation differs from the one the investigation agent returned.
 * `explicit_request` means the transcript deterministically asked for a new work order;
 * `forced` means the application supplied `metadata.forceAction`.
 */
export type ActionOverrideReason = "explicit_request" | "forced";

export interface NormalizedInvestigationInput {
  source: InvestigationSource;
  transcript: string;
  timestamp: string;
  sessionId: string | null;
  metadata: Record<string, unknown>;
}

export interface TriageResult {
  intent: TriageIntent;
  assetId: string | null;
  plantId: string | null;
  issue: string | null;
  severity: TriageSeverity | null;
  requiresInvestigation: boolean;
  clarification?: string;
}

export interface InvestigationResult {
  findings: string[];
  probableIssue: string | null;
  supportingEvidence: string[];
  recommendedAction: InvestigationAction;
  rationale: string;
  /**
   * Work-order codes the investigation found already relevant to this asset.
   * This is evidence, never a decision: it neither authorizes nor vetoes an action.
   */
  existingWorkOrderCodes: string[];
  clarification?: string;
}

export type ActionEntity = "work_order" | "incident" | "maintenance_record";

export interface ActionExecutionResult {
  actionType: ActionRequest["type"];
  entity: ActionEntity;
  id: string;
  code: string;
  assetId: string;
  assetCode: string;
  summary: string;
  details: Record<string, string | number | boolean | null>;
}

export interface VerificationResult {
  success: boolean;
  summary: string;
  memoryCandidate?: {
    text: string;
    sourceId: string;
  };
}

export interface ActionVerificationFact {
  persisted: boolean;
  matches: boolean;
  record: Record<string, unknown> | null;
}

export type WorkflowStatus = "completed" | "clarification_required" | "failed";

export type MemoryType =
  | "INCIDENT"
  | "MAINTENANCE"
  | "WORK_ORDER"
  | "SOP"
  | "ASSET_CONTEXT"
  | "AGENT_RESULT";

export interface MemoryPersistenceStatus {
  attempted: boolean;
  persisted: boolean;
  memoryId?: string;
  type?: MemoryType;
  collection?: string;
  error?: string;
}

export interface AgentStepTrace {
  role: "triage" | "investigation" | "action" | "verification";
  status: "completed" | "skipped" | "failed";
  provider?: "mock" | "lyzr";
  mock: boolean;
  latencyMs: number;
  error?: string;
}

export type WorkflowStageId =
  | "input"
  | "triage"
  | "memory_retrieval"
  | "investigation"
  | "action"
  | "database_verification"
  | "memory_persistence";

export type WorkflowStageState = "pending" | "running" | "completed" | "skipped" | "failed";

export interface WorkflowStage {
  id: WorkflowStageId;
  label: string;
  state: WorkflowStageState;
  detail: string | null;
  actor: string | null;
  latencyMs: number | null;
}

export interface WorkflowMemoryView {
  memoryId: string;
  type: string;
  asset: string;
  plant: string;
  score: number;
  source: string | null;
  preview: string;
}

export type WorkflowAgentRole = "triage" | "investigation" | "action" | "verification";

export interface WorkflowAgentView {
  role: WorkflowAgentRole;
  label: string;
  status: "completed" | "skipped" | "failed";
  provider: string | null;
  mock: boolean;
  decision: string | null;
  latencyMs: number;
}

export interface WorkflowDatabaseActionView {
  actionType: string;
  entity: string;
  code: string;
  asset: string;
  status: string | null;
  priority: string | null;
  verified: boolean;
  summary: string;
}

export type MemoryResolutionBasis = "agent_result_memory" | "semantic_memory";

export interface WorkflowAssetResolution {
  fromMemory: boolean;
  assetCode: string | null;
  plantCode: string | null;
  basis?: MemoryResolutionBasis;
}

export interface WorkflowTrace {
  status: WorkflowStatus;
  inputSource: InvestigationSource;
  inputLabel: string;
  inputChannel: "omi_voice" | "dev_text";
  stages: WorkflowStage[];
  agents: WorkflowAgentView[];
  memories: WorkflowMemoryView[];
  action: WorkflowDatabaseActionView | null;
  verification: { success: boolean; summary: string } | null;
  memoryPersistence: MemoryPersistenceStatus | null;
  assetResolution: WorkflowAssetResolution | null;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  triage: TriageResult;
  retrieval: RetrievalInfo | null;
  investigation: InvestigationResult | null;
  /**
   * The recommendation the investigation agent actually returned, preserved when the
   * backend replaced it with an effective recommendation. `investigation.recommendedAction`
   * is always the effective one; this is the untouched historical value.
   */
  agentRecommendedAction?: InvestigationAction;
  /** Why the effective recommendation differs from the agent's, when it does. */
  actionOverrideReason?: ActionOverrideReason;
  actionRequest: ActionRequest | null;
  action: ActionExecutionResult | null;
  verification: VerificationResult | null;
  memoryPersistence: MemoryPersistenceStatus | null;
  trace: WorkflowTrace;
  steps: AgentStepTrace[];
  error?: string;
  errorKind?: PipeErrorKind;
  errorStatus?: number;
}

export interface InvestigateResult {
  answer: string;
  evidence: Evidence[];
  retrieval: RetrievalInfo;
  model?: string;
  latency: {
    llmMs: number;
    totalMs: number;
    workflowMs?: number;
  };
  workflow?: WorkflowResult;
}

export interface ApiError {
  error: {
    kind: PipeErrorKind;
    message: string;
  };
}

export interface PlantSummary {
  id: string;
  code: string;
  name: string;
  location: string | null;
}

export interface AssetSummary {
  id: string;
  code: string;
  name: string;
  manufacturer: string;
  model: string;
  status: string;
  plant: PlantSummary;
  incidentCount: number;
  maintenanceCount: number;
  workOrderCount: number;
  sopCount: number;
}

export type InvestigationPhase = "idle" | "loading" | "success" | "error";
