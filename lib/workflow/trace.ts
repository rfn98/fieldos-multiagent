import type { QdrantRetrieval } from "../qdrant/retrieval";
import type {
  ActionExecutionResult,
  ActionOverrideReason,
  AgentStepTrace,
  InvestigationAction,
  InvestigationResult,
  MemoryPersistenceStatus,
  MemoryResolutionBasis,
  NormalizedInvestigationInput,
  TriageResult,
  VerificationResult,
  WorkflowAgentRole,
  WorkflowAgentView,
  WorkflowDatabaseActionView,
  WorkflowMemoryView,
  WorkflowStage,
  WorkflowStageId,
  WorkflowStageState,
  WorkflowStatus,
  WorkflowTrace,
} from "../types";
import type { OperationalAssetContext } from "./agents";

const STAGE_LABELS: Record<WorkflowStageId, string> = {
  input: "INPUT",
  triage: "TRIAGE",
  memory_retrieval: "MEMORY RETRIEVAL",
  investigation: "INVESTIGATION",
  action: "ACTION",
  database_verification: "DATABASE VERIFICATION",
  memory_persistence: "MEMORY PERSISTENCE",
};

const ACTOR_LABELS: Record<WorkflowStageId, string> = {
  input: "input",
  triage: "lyzr",
  memory_retrieval: "qdrant",
  investigation: "lyzr",
  action: "lyzr",
  database_verification: "postgres",
  memory_persistence: "qdrant",
};

const AGENT_LABELS: Record<WorkflowAgentRole, string> = {
  triage: "TRIAGE AGENT",
  investigation: "INVESTIGATION AGENT",
  action: "ACTION AGENT",
  verification: "VERIFICATION AGENT",
};

const AGENT_ROLES: WorkflowAgentRole[] = ["triage", "investigation", "action", "verification"];

const STAGE_ORDER: WorkflowStageId[] = [
  "input",
  "triage",
  "memory_retrieval",
  "investigation",
  "action",
  "database_verification",
  "memory_persistence",
];

const PREVIEW_LENGTH = 180;

function previewText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > PREVIEW_LENGTH
    ? `${normalized.slice(0, PREVIEW_LENGTH - 3)}...`
    : normalized;
}

function detailValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function inputSourceLabel(source: NormalizedInvestigationInput["source"]): {
  label: string;
  channel: WorkflowTrace["inputChannel"];
} {
  return source === "omi"
    ? { label: "VOICE INPUT — OMI", channel: "omi_voice" }
    : { label: "TEXT INPUT — DEV/TEST", channel: "dev_text" };
}

function stepFor(steps: AgentStepTrace[], role: WorkflowAgentRole): AgentStepTrace | null {
  return steps.find((step) => step.role === role) ?? null;
}

function stageFromStep(
  id: WorkflowStageId,
  step: AgentStepTrace | null,
  detail: string | null
): WorkflowStage {
  const state: WorkflowStageState = !step
    ? "skipped"
    : step.status === "completed"
      ? "completed"
      : step.status === "failed"
        ? "failed"
        : "skipped";
  return {
    id,
    label: STAGE_LABELS[id],
    state,
    detail: state === "skipped" && step?.error ? step.error : detail,
    actor: ACTOR_LABELS[id],
    latencyMs: step && step.latencyMs > 0 ? step.latencyMs : null,
  };
}

function memoryViews(retrieval: QdrantRetrieval | null): WorkflowMemoryView[] {
  if (!retrieval) return [];
  return retrieval.docs.map((doc) => ({
    memoryId: doc.memoryId || doc.id,
    type: doc.type ?? doc.metadata.type ?? "unknown",
    asset: detailValue(doc.metadata.asset_code) ?? detailValue(doc.assetId) ?? "—",
    plant: detailValue(doc.metadata.plant_code) ?? detailValue(doc.plantId) ?? "—",
    score: doc.score,
    source: detailValue(doc.source) ?? detailValue(doc.metadata.source),
    preview: previewText(doc.text),
  }));
}

function triageDecision(triage: TriageResult): string {
  const asset = triage.assetId ? `Asset: ${triage.assetId}` : "Asset: unresolved";
  const severity = triage.severity ? ` · Severity: ${triage.severity}` : "";
  return `Intent: ${triage.intent} · ${asset}${severity}`;
}

function investigationDecision(
  investigation: InvestigationResult | null,
  retrieval: QdrantRetrieval | null,
  agentRecommendedAction: InvestigationAction | null
): string | null {
  if (!investigation) return null;
  const evidenceCount = retrieval?.docs.length ?? 0;
  const override =
    agentRecommendedAction && agentRecommendedAction !== investigation.recommendedAction
      ? ` · agent recommended: ${agentRecommendedAction}`
      : "";
  const existing = investigation.existingWorkOrderCodes.length > 0
    ? ` · existing work orders: ${investigation.existingWorkOrderCodes.join(", ")}`
    : "";
  return `Decision: ${investigation.recommendedAction} · Evidence: ${evidenceCount} record${
    evidenceCount === 1 ? "" : "s"
  }${override}${existing}`;
}

/**
 * Every `ActionOverrideReason` is mapped explicitly, so adding a cause cannot
 * silently fall through to a generic label and make an application force
 * indistinguishable from a user-authorised request.
 */
const OVERRIDE_CAUSE: Record<ActionOverrideReason, string> = {
  explicit_request: "an explicit user request",
  forced: "application policy",
};

/**
 * Describes why the effective recommendation differs from the agent's own, so an
 * override is never indistinguishable from an agent decision.
 */
function overrideNote(
  agentRecommendedAction: InvestigationAction | null,
  reason: ActionOverrideReason | null
): string {
  if (!agentRecommendedAction || !reason) return "";
  const cause = OVERRIDE_CAUSE[reason];
  return ` · overridden by ${cause} (agent recommended ${agentRecommendedAction})`;
}

function actionDecision(
  action: ActionExecutionResult | null,
  investigation: InvestigationResult | null,
  agentRecommendedAction: InvestigationAction | null,
  actionOverrideReason: ActionOverrideReason | null
): string | null {
  if (action) return `Action: ${action.actionType} · ${action.code}${overrideNote(agentRecommendedAction, actionOverrideReason)}`;
  // A completed workflow is not a mutation. Say so explicitly, and say when a
  // recommended action was dropped, so a no-op never reads like a written record.
  if (investigation && investigation.recommendedAction !== "NO_ACTION") {
    return `Action: NOT EXECUTED · ${investigation.recommendedAction} was recommended but no database change was made`;
  }
  if (investigation) {
    const existing = investigation.existingWorkOrderCodes.length > 0
      ? ` · existing work orders: ${investigation.existingWorkOrderCodes.join(", ")}`
      : "";
    return `Action: NO_ACTION · no database change was made${existing}`;
  }
  return "Action: none · no database change was made";
}

function verificationDecision(verification: VerificationResult | null): string | null {
  if (!verification) return null;
  return verification.success ? "Result: VERIFIED" : "Result: NOT VERIFIED";
}

function agentDecision(
  role: WorkflowAgentRole,
  state: {
    triage: TriageResult;
    investigation: InvestigationResult | null;
    retrieval: QdrantRetrieval | null;
    action: ActionExecutionResult | null;
    verification: VerificationResult | null;
    agentRecommendedAction?: InvestigationAction | null;
    actionOverrideReason?: ActionOverrideReason | null;
  }
): string | null {
  switch (role) {
    case "triage":
      return triageDecision(state.triage);
    case "investigation":
      return investigationDecision(
        state.investigation,
        state.retrieval,
        state.agentRecommendedAction ?? null
      );
    case "action":
      return actionDecision(
        state.action,
        state.investigation,
        state.agentRecommendedAction ?? null,
        state.actionOverrideReason ?? null
      );
    case "verification":
      return verificationDecision(state.verification);
  }
}

function databaseActionView(
  action: ActionExecutionResult | null,
  verification: VerificationResult | null
): WorkflowDatabaseActionView | null {
  if (!action) return null;
  return {
    actionType: action.actionType,
    entity: action.entity,
    code: action.code,
    asset: action.assetCode,
    status: detailValue(action.details.status as string | null | undefined),
    priority: detailValue(action.details.priority as string | null | undefined),
    verified: verification?.success === true,
    summary: action.summary,
  };
}

export interface WorkflowTraceState {
  input: NormalizedInvestigationInput;
  status: WorkflowStatus;
  asset: OperationalAssetContext | null;
  assetFromMemory: boolean;
  memoryResolutionBasis?: MemoryResolutionBasis | null;
  retrieval: QdrantRetrieval | null;
  contextRetrieval: QdrantRetrieval | null;
  steps: AgentStepTrace[];
  triage: TriageResult;
  investigation: InvestigationResult | null;
  action: ActionExecutionResult | null;
  verification: VerificationResult | null;
  memoryPersistence: MemoryPersistenceStatus | null;
  agentRecommendedAction?: InvestigationAction | null;
  actionOverrideReason?: ActionOverrideReason | null;
  error?: string | null;
}

export function buildWorkflowTrace(state: WorkflowTraceState): WorkflowTrace {
  const { input, steps, triage, investigation, action, verification, memoryPersistence } = state;
  const source = inputSourceLabel(input.source);
  const effectiveRetrieval = state.retrieval ?? state.contextRetrieval;
  const triageStep = stepFor(steps, "triage");
  const investigationStep = stepFor(steps, "investigation");
  const actionStep = stepFor(steps, "action");

  const retrievalStage: WorkflowStage = effectiveRetrieval
    ? {
        id: "memory_retrieval",
        label: STAGE_LABELS.memory_retrieval,
        state: "completed",
        detail: `${effectiveRetrieval.docs.length} memor${
          effectiveRetrieval.docs.length === 1 ? "y" : "ies"
        } from ${effectiveRetrieval.collectionName}`,
        actor: ACTOR_LABELS.memory_retrieval,
        latencyMs: effectiveRetrieval.latencyMs,
      }
    : {
        id: "memory_retrieval",
        label: STAGE_LABELS.memory_retrieval,
        state: "skipped",
        detail: "No memory retrieval was required for this request.",
        actor: ACTOR_LABELS.memory_retrieval,
        latencyMs: null,
      };

  const actionStage: WorkflowStage = action
    ? {
        id: "action",
        label: STAGE_LABELS.action,
        state: verification?.success === true ? "completed" : "failed",
        detail: actionDecision(
          action,
          investigation,
          state.agentRecommendedAction ?? null,
          state.actionOverrideReason ?? null
        ),
        actor: ACTOR_LABELS.action,
        latencyMs: actionStep && actionStep.latencyMs > 0 ? actionStep.latencyMs : null,
      }
    : actionStep && actionStep.status === "completed"
      ? {
          id: "action",
          label: STAGE_LABELS.action,
          state: "failed",
          detail: state.error ?? verification?.summary ?? "The action agent produced no database record.",
          actor: ACTOR_LABELS.action,
          latencyMs: actionStep.latencyMs > 0 ? actionStep.latencyMs : null,
        }
      : stageFromStep("action", actionStep, null);

  const verificationStage: WorkflowStage = verification
    ? {
        id: "database_verification",
        label: STAGE_LABELS.database_verification,
        state: verification.success ? "completed" : "failed",
        detail: verification.success ? "Persisted record read back and matched." : verification.summary,
        actor: ACTOR_LABELS.database_verification,
        latencyMs: null,
      }
    : {
        id: "database_verification",
        label: STAGE_LABELS.database_verification,
        state: "skipped",
        detail: action ? "No verification result was recorded." : "No database action was executed.",
        actor: ACTOR_LABELS.database_verification,
        latencyMs: null,
      };

  const persistenceStage: WorkflowStage = !memoryPersistence || !memoryPersistence.attempted
    ? {
        id: "memory_persistence",
        label: STAGE_LABELS.memory_persistence,
        state: "skipped",
        detail: action ? "Agent-result memory was not attempted." : "No verified action to persist.",
        actor: ACTOR_LABELS.memory_persistence,
        latencyMs: null,
      }
    : memoryPersistence.persisted
      ? {
          id: "memory_persistence",
          label: STAGE_LABELS.memory_persistence,
          state: "completed",
          detail: detailValue(memoryPersistence.memoryId),
          actor: ACTOR_LABELS.memory_persistence,
          latencyMs: null,
        }
      : {
          id: "memory_persistence",
          label: STAGE_LABELS.memory_persistence,
          state: "failed",
          detail: detailValue(memoryPersistence.error) ?? "Agent-result memory was not persisted.",
          actor: ACTOR_LABELS.memory_persistence,
          latencyMs: null,
        };

  const stages: Record<WorkflowStageId, WorkflowStage> = {
    input: {
      id: "input",
      label: STAGE_LABELS.input,
      state: "completed",
      detail: source.label,
      actor: source.channel === "omi_voice" ? "omi" : "dev",
      latencyMs: null,
    },
    triage: stageFromStep("triage", triageStep, triageDecision(triage)),
    memory_retrieval: retrievalStage,
    investigation: stageFromStep(
      "investigation",
      investigationStep,
      investigationDecision(
        investigation,
        state.retrieval,
        state.agentRecommendedAction ?? null
      )
    ),
    action: actionStage,
    database_verification: verificationStage,
    memory_persistence: persistenceStage,
  };

  const agents: WorkflowAgentView[] = AGENT_ROLES.map((role) => {
    const step = stepFor(steps, role);
    return {
      role,
      label: AGENT_LABELS[role],
      status: step?.status ?? "skipped",
      provider: step?.provider ?? null,
      mock: step?.mock ?? false,
      decision: agentDecision(role, {
        triage,
        investigation,
        retrieval: state.retrieval,
        action,
        verification,
        agentRecommendedAction: state.agentRecommendedAction ?? null,
        actionOverrideReason: state.actionOverrideReason ?? null,
      }),
      latencyMs: step?.latencyMs ?? 0,
    };
  });

  return {
    status: state.status,
    inputSource: input.source,
    inputLabel: source.label,
    inputChannel: source.channel,
    stages: STAGE_ORDER.map((id) => stages[id]),
    agents,
    memories: memoryViews(effectiveRetrieval),
    action: databaseActionView(action, verification),
    verification: verification ? { success: verification.success, summary: verification.summary } : null,
    memoryPersistence,
    assetResolution: state.asset
      ? {
          fromMemory: state.assetFromMemory,
          assetCode: state.asset.code,
          plantCode: state.asset.plant.code,
          ...(state.assetFromMemory && state.memoryResolutionBasis
            ? { basis: state.memoryResolutionBasis }
            : {}),
        }
      : null,
  };
}
