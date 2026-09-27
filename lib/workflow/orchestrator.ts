import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import { persistAgentMemory } from "../memory/persistence";
import type { AgentMemoryInput } from "../memory/types";
import { retrieveQdrant, type QdrantRetrieval } from "../qdrant/retrieval";
import { executeActionRequest } from "../actions";
import { parseActionRequest, type ActionRequest } from "../actions/validation";
import {
  PipeError,
  type ActionExecutionResult,
  type ActionOverrideReason,
  type ActionVerificationFact,
  type AgentStepTrace,
  type Evidence,
  type InvestigateResult,
  type InvestigationResult,
  type MemoryPersistenceStatus,
  type MemoryResolutionBasis,
  type NormalizedInvestigationInput,
  type RetrievalInfo,
  type TriageResult,
  type VerificationResult,
  type WorkflowResult,
  type WorkflowTrace,
} from "../types";
import {
  runAction,
  runInvestigation,
  runTriage,
  runVerification,
  retrieveEvidence,
  skippedAgentStep,
  type AgentContext,
  type OperationalAssetContext,
} from "./agents";
import { normalizeInvestigateInput, type InvestigateInput } from "./input";
import { buildWorkflowTrace } from "./trace";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_EVIDENCE_SCORE = 0.25;
const EMPTY_RETRIEVAL: Omit<RetrievalInfo, "query"> = {
  provider: "qdrant",
  indexName: "not-run",
  latencyMs: null,
  documents: 0,
};

export interface WorkflowDependencies {
  client?: PrismaClient;
  retrieve?: (input: NormalizedInvestigationInput, asset: OperationalAssetContext) => Promise<QdrantRetrieval>;
  retrieveContext?: (input: NormalizedInvestigationInput) => Promise<QdrantRetrieval>;
  persistMemory?: (input: AgentMemoryInput) => Promise<MemoryPersistenceStatus>;
  now?: () => Date;
}

function clientFor(dependencies: WorkflowDependencies): PrismaClient {
  return dependencies.client ?? prisma;
}

const ASSET_REFERENCE_BOUNDARY = "(?=$|[^A-Z0-9._/-]|\\.(?=$|[^A-Z0-9._/-]))";
const ASSET_CODE_PATTERN = new RegExp(
  `(?<![A-Z0-9._/-])\\b[A-Z]{1,5}-\\d{2,}${ASSET_REFERENCE_BOUNDARY}`,
  "gi"
);
const ASSET_UUID_PATTERN = new RegExp(
  `(?<![A-Z0-9._/-])\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${ASSET_REFERENCE_BOUNDARY}`,
  "gi"
);

/**
 * A creation verb, optionally separated from `work order` by a small window of
 * filler words ("a new", "an urgent", "for P-204"). The window is deliberately
 * tight so a verb and a later unrelated mention of a work order cannot combine
 * into a false positive.
 */
const WORK_ORDER_NOUN = "work[\\s-]?orders?";
const WORK_ORDER_CREATION_GAP = "(?:\\s+\\w+){0,3}";
const WORK_ORDER_GAP_REQUIRED = "(?:\\s+\\w+){1,3}";
const WORK_ORDER_NOUN_TAIL = `\\s*\\b${WORK_ORDER_NOUN}\\b`;

/**
 * `open` is the one creation verb that is also a common status adjective, so
 * "the open work order" must not read as a request. It is therefore only treated
 * as a verb when something sits between it and the noun ("open a work order").
 */
const EXPLICIT_CREATE_WORK_ORDER_PATTERN = new RegExp(
  `\\b(?:create|raise|log|add|file|submit|generate|schedule)\\b${WORK_ORDER_CREATION_GAP}${WORK_ORDER_NOUN_TAIL}` +
    `|\\bopen\\b${WORK_ORDER_GAP_REQUIRED}${WORK_ORDER_NOUN_TAIL}`,
  "i"
);

/**
 * A conditional wrapper around the creation request ("...but only if there isn't
 * one already"). The backend will not evaluate the condition, so a conditional
 * request must not be read as an unconditional authorization to write.
 */
const CONDITIONAL_CLAUSE_PATTERN =
  /\b(?:if|unless|only\s+if|in\s+case|provided\s+that|as\s+long\s+as|when\s+there(?:'s|\s+is)\s+not)\b/i;

/** Sentence end, so a condition is only read as qualifying the request it attaches to. */
const SENTENCE_BOUNDARY_PATTERN = /[.!?\n]/;

/**
 * Extracts an explicit, unconditional request to create a work order.
 *
 * Under the approved policy an explicit user request outranks an investigation's
 * `NO_ACTION`, so this function is an authorization input: a false negative merely
 * falls back to the previous behaviour, while a false positive could write to the
 * maintenance database. It therefore abstains rather than guesses, and recognises
 * only a creation verb applied to a work order. It is not a general intent
 * classifier, and it deliberately does not evaluate conditions, read status
 * requests, or decide anything about safety — grounding, asset resolution, and
 * strict action validation all still apply downstream.
 *
 * Returns `"CREATE_WORK_ORDER"` or `null` and nothing else, so the parser cannot
 * widen its authority to another action type without a signature change.
 */
export function requestedActionFromTranscript(transcript: string): "CREATE_WORK_ORDER" | null {
  if (!transcript) return null;
  const match = EXPLICIT_CREATE_WORK_ORDER_PATTERN.exec(transcript);
  if (!match) return null;
  const matchEnd = match.index + match[0].length;
  // A condition can qualify the request from either side ("only if needed, create
  // a work order" / "create a work order if none is open"). Both are bounded by the
  // enclosing sentence so an unrelated condition elsewhere in a long report does not
  // discard a direct command, and so a later sentence does not qualify this one.
  const before = transcript.slice(Math.max(0, match.index - CONDITIONAL_CLAUSE_WINDOW), match.index);
  const after = transcript.slice(matchEnd).split(SENTENCE_BOUNDARY_PATTERN, 1)[0];
  if (CONDITIONAL_CLAUSE_PATTERN.test(before)) return null;
  if (CONDITIONAL_CLAUSE_PATTERN.test(after)) return null;
  return "CREATE_WORK_ORDER";
}

/** How far before the match a conditional clause is still treated as governing it. */
const CONDITIONAL_CLAUSE_WINDOW = 80;

function explicitAssetReferences(transcript: string): string[] {
  const codes = Array.from(transcript.matchAll(ASSET_CODE_PATTERN), (match) => match[0].toUpperCase());
  const uuids = Array.from(transcript.matchAll(ASSET_UUID_PATTERN), (match) => match[0].toLowerCase());
  return uniqueReferences([...codes, ...uuids]);
}

/**
 * Canonicalizes an asset identifier supplied by an agent into the form FieldOS stores.
 *
 * A live agent answers `assetId` in prose ("Pump P-204"), so the raw value is not comparable to a
 * stored code. The canonical form is recovered by reusing the same deterministic extraction already
 * applied to the transcript, so nothing here is fuzzy: a value that carries no recognizable asset
 * reference is returned unchanged and therefore still fails the exact `assetMatches` guard, while a
 * genuine disagreement between the agent and the transcript still fails closed. The agent's stated
 * `assetId` is never rewritten; this is used only to pick the candidate that internal resolution
 * compares against the database.
 */
function canonicalAssetReference(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const references = explicitAssetReferences(value);
  if (references.length > 0) return references[0];
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizedReference(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function metadataAssetReferences(metadata: Record<string, unknown>): string[] {
  const values: string[] = [];
  for (const key of ["assetId", "asset_id", "assetCode", "asset_code"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
  }
  const structured = metadata.structured;
  if (typeof structured === "object" && structured !== null && !Array.isArray(structured)) {
    for (const key of ["assetId", "asset_id", "assetCode", "asset_code"]) {
      const value = (structured as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) values.push(value.trim());
    }
  }
  return values;
}

/**
 * Reads the application-controlled force flag.
 *
 * This is read exclusively from request metadata. It is never derived from an
 * agent response, because a model must not be able to grant itself permission to
 * write. It is also not a general "skip safety" switch: grounding, asset
 * resolution, strict action validation, and the read-back verification all still
 * apply, and `NEEDS_CLARIFICATION` from the action agent still wins.
 */
function metadataForceAction(metadata: Record<string, unknown>): boolean {
  return metadata.forceAction === true;
}

/**
 * An explicit code supplied by the application, used instead of the generated
 * hash code. This is only a pass-through of an already-supported action field; it
 * adds no idempotency or duplicate-detection behaviour.
 */
function metadataWorkOrderCode(metadata: Record<string, unknown>): string | undefined {
  for (const key of ["workOrderCode", "work_order_code"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Triage severity to work-order priority, reusing the agent path's own mapping. */
function priorityForSeverity(severity: TriageResult["severity"]): "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" {
  if (severity === "LOW" || severity === "MEDIUM" || severity === "HIGH" || severity === "CRITICAL") {
    return severity;
  }
  return "MEDIUM";
}

/**
 * Why a deterministic request was built instead of taking the action agent's.
 *
 * `forced` is `metadata.forceAction` supplied by the application. `explicit_request`
 * is a create request the deterministic transcript parser recognised. Both build
 * their values from resolved backend data and both re-enter the same validated
 * execution path, so the label only records the cause, never the authority.
 */
type DeterministicRequestMode = Extract<ActionOverrideReason, "forced" | "explicit_request">;

/**
 * Builds the `CREATE_WORK_ORDER` request for the force and explicit-request paths
 * from resolved data only.
 *
 * The asset is already resolved and validated upstream, and the title, description,
 * reason, and priority are all derived from the transcript, the triage issue, and the
 * triage severity. Nothing is invented, and the result is returned through
 * `parseActionRequest` so it is subject to exactly the same strict schema as an
 * agent-authored request. An unresolvable asset yields `NEEDS_CLARIFICATION`, which
 * keeps "missing identifiers" a clarification outcome rather than a write.
 *
 * `mode` only selects the wording that records why this request exists. There is one
 * builder, not one per cause, so the two paths cannot drift into different validation.
 */
function forcedWorkOrderRequest(input: {
  asset: OperationalAssetContext | null;
  triage: TriageResult;
  transcript: string;
  existingWorkOrderCodes: string[];
  code?: string;
  mode?: DeterministicRequestMode;
}): ActionRequest | { type: "NEEDS_CLARIFICATION"; reason: string; clarification: string } {
  const { asset, triage, transcript, existingWorkOrderCodes, code } = input;
  const mode: DeterministicRequestMode = input.mode ?? "forced";
  if (!asset) {
    return {
      type: "NEEDS_CLARIFICATION",
      reason: "A deterministic work order requires an explicitly resolved asset.",
      clarification: "An explicit asset code is required before a work order can be created.",
    };
  }

  const known = existingWorkOrderCodes.length > 0
    ? ` Known existing work orders: ${existingWorkOrderCodes.join(", ")}.`
    : "";
  const priority = priorityForSeverity(triage.severity);
  const titlePrefix = mode === "forced" ? "Forced work order" : "Requested work order";
  const reasonPrefix = mode === "forced"
    ? "Explicitly forced by the application after the action agent did not select an action."
    : "Created from an explicit user request after the action agent declined. Deterministic application policy authorised the request.";

  return parseActionRequest({
    type: "CREATE_WORK_ORDER",
    assetId: asset.id,
    title: `${titlePrefix}: ${triage.issue ?? asset.name}`.slice(0, 10000),
    description: `From the original field report: ${transcript}`.slice(0, 10000),
    reason: `${reasonPrefix}${known}`.slice(0, 4000),
    priority,
    status: "OPEN",
    ...(code ? { code } : {}),
  });
}

function containsExplicitReference(text: string, candidate: string): boolean {
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const structuredReference =
    /^[A-Z]{1,5}-\d{2,}$/i.test(candidate) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate);
  const endBoundary = structuredReference
    ? ASSET_REFERENCE_BOUNDARY
    : "(?=$|[^A-Z0-9._/-])";
  return new RegExp(`(^|[^A-Z0-9._/-])${escaped}${endBoundary}`, "i").test(text);
}

function normalizedMemoryType(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

/**
 * Resolves asset candidates from retrieved memory.
 *
 * `AGENT_RESULT` documents are records of a completed field report, so they carry an explicit
 * asset identity and are used as anchors when present. Anchors that lack a usable UUID are
 * ignored. When no anchor survives, the whole above-threshold result set is used, preserving the
 * original semantic-memory behavior.
 */
function memoryAssetCandidates(retrieval: QdrantRetrieval): {
  candidates: string[];
  basis: MemoryResolutionBasis;
} {
  const relevant = retrieval.docs.filter((doc) => doc.score >= MIN_EVIDENCE_SCORE);
  const anchorValues: string[] = [];
  const semanticValues: string[] = [];
  for (const doc of relevant) {
    const value = doc.assetId ?? doc.metadata.asset_id ?? doc.metadata.assetId;
    if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) continue;
    const assetId = value.trim().toLowerCase();
    semanticValues.push(assetId);
    if (normalizedMemoryType(doc.type ?? doc.metadata.type) === "agent_result") anchorValues.push(assetId);
  }
  if (anchorValues.length > 0) {
    return { candidates: uniqueReferences(anchorValues), basis: "agent_result_memory" };
  }
  return { candidates: uniqueReferences(semanticValues), basis: "semantic_memory" };
}

function isExplicitAssetReference(
  candidate: string,
  input: NormalizedInvestigationInput
): boolean {
  const transcriptReference = containsExplicitReference(input.transcript, candidate);
  const metadataReference = metadataAssetReferences(input.metadata).some(
    (value) => normalizedReference(value) === normalizedReference(candidate)
  );
  return transcriptReference || metadataReference;
}

function uniqueReferences(values: string[]): string[] {
  const unique = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toUpperCase();
    if (!unique.has(key)) unique.set(key, trimmed);
  }
  return Array.from(unique.values());
}

function boundedText(value: string, max = 3000): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

async function loadAsset(
  client: PrismaClient,
  value: string
): Promise<OperationalAssetContext | null> {
  const normalized = value.trim();
  let asset = await client.asset.findUnique({
    where: UUID_PATTERN.test(normalized) ? { id: normalized } : { code: normalized },
    include: {
      plant: true,
      incidents: {
        include: { technician: true },
        orderBy: { occurredAt: "desc" },
        take: 5,
      },
      maintenanceRecords: {
        include: { technician: true },
        orderBy: { performedAt: "desc" },
        take: 5,
      },
      workOrders: {
        include: { technician: true },
        orderBy: { updatedAt: "desc" },
        take: 10,
      },
      sops: {
        orderBy: { code: "asc" },
        take: 5,
      },
    },
  });
  if (!asset && !UUID_PATTERN.test(normalized)) {
    const uppercase = normalized.toUpperCase();
    if (uppercase !== normalized) {
      asset = await client.asset.findUnique({
        where: { code: uppercase },
        include: {
          plant: true,
          incidents: {
            include: { technician: true },
            orderBy: { occurredAt: "desc" },
            take: 5,
          },
          maintenanceRecords: {
            include: { technician: true },
            orderBy: { performedAt: "desc" },
            take: 5,
          },
          workOrders: {
            include: { technician: true },
            orderBy: { updatedAt: "desc" },
            take: 10,
          },
          sops: {
            orderBy: { code: "asc" },
            take: 5,
          },
        },
      });
    }
  }

  if (!asset) return null;

  const openWorkOrder = asset.workOrders.find((workOrder) => workOrder.status === "OPEN");
  const latestWorkOrder = asset.workOrders[0];
  const latestIncident = asset.incidents[0];
  const assignedTechnician =
    openWorkOrder?.technician ?? latestWorkOrder?.technician ?? latestIncident?.technician ?? null;

  return {
    id: asset.id,
    code: asset.code,
    name: asset.name,
    manufacturer: asset.manufacturer,
    model: asset.model,
    status: asset.status,
    plant: {
      id: asset.plant.id,
      code: asset.plant.code,
      name: asset.plant.name,
      location: asset.plant.location,
    },
    assignedTechnicianCode: assignedTechnician?.code ?? null,
    openWorkOrderCode: openWorkOrder?.code ?? null,
    latestIncidentCode: latestIncident?.code ?? null,
    incidents: asset.incidents.map((incident) => ({
      code: incident.code,
      title: boundedText(incident.title, 500),
      description: boundedText(incident.description),
      rootCause: boundedText(incident.rootCause),
      severity: incident.severity,
      occurredAt: incident.occurredAt.toISOString(),
      resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    })),
    maintenanceRecords: asset.maintenanceRecords.map((record) => ({
      code: record.code,
      type: record.type,
      title: boundedText(record.title, 500),
      description: boundedText(record.description),
      actionTaken: boundedText(record.actionTaken),
      performedAt: record.performedAt.toISOString(),
    })),
    workOrders: asset.workOrders.map((workOrder) => ({
      code: workOrder.code,
      title: boundedText(workOrder.title, 500),
      description: boundedText(workOrder.description),
      priority: workOrder.priority,
      status: workOrder.status,
      scheduledAt: workOrder.scheduledAt.toISOString(),
      completedAt: workOrder.completedAt?.toISOString() ?? null,
      technicianCode: workOrder.technician.code,
    })),
    sops: asset.sops.map((sop) => ({
      code: sop.code,
      title: boundedText(sop.title, 500),
      category: sop.category,
      content: boundedText(sop.content, 6000),
    })),
  };
}

function emptyRetrieval(query: string): RetrievalInfo {
  return { ...EMPTY_RETRIEVAL, query };
}

function evidenceFromRetrieval(retrieval: QdrantRetrieval): Evidence[] {
  return retrieval.docs.map((doc) => ({
    id: doc.id,
    type: doc.type ?? doc.metadata.type ?? "unknown",
    assetId: doc.assetId ?? doc.metadata.asset_id ?? doc.metadata.assetId ?? "unknown",
    plantId: doc.plantId ?? doc.metadata.plant_id ?? doc.metadata.plantId,
    severity: doc.metadata.severity,
    category: doc.metadata.category,
    date: doc.metadata.date,
    score: doc.score,
    snippet: boundedText(doc.text, 600),
  }));
}

function retrievalInfo(retrieval: QdrantRetrieval): RetrievalInfo {
  return {
    provider: "qdrant",
    indexName: retrieval.collectionName,
    collectionName: retrieval.collectionName,
    latencyMs: retrieval.latencyMs,
    documents: retrieval.docs.length,
    query: retrieval.query,
  };
}

function contextFor(
  input: NormalizedInvestigationInput,
  triage: TriageResult | null,
  asset: OperationalAssetContext | null,
  retrieval: QdrantRetrieval | null,
  investigation: InvestigationResult | null,
  action: ActionExecutionResult | null,
  actionVerification: ActionVerificationFact | null = null
): AgentContext {
  return { input, asset, triage, retrieval, investigation, action, actionVerification };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof PipeError) return error.message;
  return "The workflow could not complete the requested step.";
}

function workflowResult(partial: {
  status: WorkflowResult["status"];
  triage: TriageResult;
  retrieval: RetrievalInfo | null;
  investigation: InvestigationResult | null;
  agentRecommendedAction?: WorkflowResult["agentRecommendedAction"];
  actionOverrideReason?: WorkflowResult["actionOverrideReason"];
  actionRequest: WorkflowResult["actionRequest"];
  action: ActionExecutionResult | null;
  verification: VerificationResult | null;
  memoryPersistence?: MemoryPersistenceStatus | null;
  trace: WorkflowResult["trace"];
  steps: AgentStepTrace[];
  error?: string;
  errorKind?: WorkflowResult["errorKind"];
  errorStatus?: number;
}): WorkflowResult {
  return {
    ...partial,
    memoryPersistence: partial.memoryPersistence ?? null,
  };
}

function clarificationAnswer(triage: TriageResult): string {
  return triage.clarification ?? "Please provide a valid FieldOS asset code, such as P-204, so the request can be investigated safely.";
}

function assetMatches(asset: OperationalAssetContext, value: string): boolean {
  return value.trim().toLowerCase() === asset.id.toLowerCase() || value.trim().toUpperCase() === asset.code.toUpperCase();
}

function actionAssetMatches(
  request: WorkflowResult["actionRequest"],
  asset: OperationalAssetContext
): boolean {
  if (!request) return true;
  if (request.type === "CREATE_WORK_ORDER" || request.type === "CREATE_INCIDENT" || request.type === "RECORD_OBSERVATION") {
    return assetMatches(asset, request.assetId);
  }
  if (request.type === "UPDATE_WORK_ORDER" && request.assetId) {
    return assetMatches(asset, request.assetId);
  }
  return true;
}

function actionFailureVerification(message: string): VerificationResult {
  return { success: false, summary: `No database action was completed. ${message}` };
}

function verificationRecord(record: unknown): Record<string, unknown> | null {
  if (!record || typeof record !== "object") return null;
  const value = record as Record<string, unknown>;
  const fields = [
    "id",
    "code",
    "assetId",
    "status",
    "priority",
    "severity",
    "type",
    "title",
    "description",
    "rootCause",
    "actionTaken",
    "technicianId",
    "scheduledAt",
    "completedAt",
    "occurredAt",
    "resolvedAt",
    "performedAt",
  ];
  return Object.fromEntries(fields.filter((field) => value[field] !== undefined).map((field) => [field, value[field]]));
}

function actionResultMatches(action: ActionExecutionResult, value: Record<string, unknown> | null): boolean {
  if (!value || value.id !== action.id || value.code !== action.code || value.assetId !== action.assetId) return false;
  const fields = [
    "title",
    "description",
    "rootCause",
    "actionTaken",
    "technicianId",
    "status",
    "priority",
    "severity",
    "type",
    "scheduledAt",
    "completedAt",
    "occurredAt",
    "resolvedAt",
    "performedAt",
  ];
  for (const field of fields) {
    const expected = action.details[field];
    if (expected === undefined) continue;
    const actual = value[field] instanceof Date ? value[field].toISOString() : value[field];
    if (actual !== expected) return false;
  }
  return true;
}

async function readActionVerification(
  client: PrismaClient,
  action: ActionExecutionResult
): Promise<ActionVerificationFact> {
  let record: unknown = null;
  if (action.entity === "work_order") {
    record = await client.workOrder.findUnique({ where: { id: action.id } });
  } else if (action.entity === "incident") {
    record = await client.incident.findUnique({ where: { id: action.id } });
  } else {
    record = await client.maintenanceRecord.findUnique({ where: { id: action.id } });
  }
  const value = record && typeof record === "object" ? (record as Record<string, unknown>) : null;
  return {
    persisted: Boolean(value),
    matches: actionResultMatches(action, value),
    record: verificationRecord(value),
  };
}

function workflowModel(steps: AgentStepTrace[]): string {
  const provider = steps.find((step) => step.provider)?.provider;
  return provider === "mock" ? "lyzr-workflow (mock)" : "lyzr-workflow";
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function currentStatusAnswer(asset: OperationalAssetContext): string {
  const workOrder = asset.workOrders[0];
  if (workOrder) {
    return `Current PostgreSQL work order ${workOrder.code} for ${asset.code} is ${workOrder.status}. ${workOrder.title}`;
  }
  return `No work order is currently recorded in PostgreSQL for ${asset.code}.`;
}

/**
 * Whether this request must reach the investigation and action stages.
 *
 * `triage.requiresInvestigation` is an optional field the agent may omit, and the schema defaults it
 * to `false` when it is absent. Trusting it alone let a report that explicitly asked for a work order
 * skip the action stage and still finish as `completed`, silently reporting success for a mutation
 * that never happened. The backend owns this decision instead: a reported issue is always
 * investigated, a status check never mutates, and any other intent keeps whatever the agent asked
 * for. The field itself is untouched and still reported, so nothing about the agent contract changes.
 */
function investigationRequired(triage: TriageResult): boolean {
  if (triage.intent === "REPORT_ISSUE") return true;
  if (triage.intent === "CHECK_STATUS") return false;
  return triage.requiresInvestigation;
}

/**
 * Names the work orders the investigation already found relevant, so the user can
 * see the system was aware of them. This is reported as context, never as a veto.
 */
function existingWorkOrderClause(investigation: InvestigationResult | null): string {
  const codes = investigation?.existingWorkOrderCodes ?? [];
  if (codes.length === 0) return "";
  const list = codes.join(", ");
  return ` Existing work order${codes.length === 1 ? "" : "s"} already on record: ${list}.`;
}

function answerFrom(
  investigation: InvestigationResult | null,
  verification: VerificationResult | null,
  triage: TriageResult,
  asset: OperationalAssetContext | null,
  action: ActionExecutionResult | null,
  agentRecommendedAction?: InvestigationResult["recommendedAction"],
  actionOverrideReason?: WorkflowResult["actionOverrideReason"]
): string {
  if (triage.intent === "CHECK_STATUS" && asset) return currentStatusAnswer(asset);
  if (verification) return verification.summary;
  if (investigation?.clarification) return investigation.clarification;
  if (investigation) {
    const findings = investigation.findings.join(" ");
    const override = overrideClause(agentRecommendedAction, actionOverrideReason);
    if (!action) {
      return `No database change was made for this request. The investigation recommended ${investigation.recommendedAction}, but no action was executed.${override} Findings: ${findings}`;
    }
    return findings;
  }
  return triage.clarification ?? "No actionable investigation result was produced.";
}

/**
 * States, in the user-facing answer, that an explicit request outranked the
 * investigation. Without this the override is only visible in the trace, and the
 * answer would read as though the investigation had chosen the action itself.
 */
function overrideClause(
  agentRecommendedAction: InvestigationResult["recommendedAction"] | undefined,
  reason: WorkflowResult["actionOverrideReason"] | undefined
): string {
  if (!agentRecommendedAction || !reason) return "";
  const cause =
    reason === "forced"
      ? "An application force request was applied"
      : "An explicit user request took precedence";
  return ` ${cause} over the investigation's ${agentRecommendedAction} recommendation.`;
}

export async function runInvestigationWorkflow(
  input: InvestigateInput,
  dependencies: WorkflowDependencies = {}
): Promise<InvestigateResult> {
  const normalized = normalizeInvestigateInput(input);
  const client = clientFor(dependencies);
  const startedAt = performance.now();
  const steps: AgentStepTrace[] = [];
  let asset: OperationalAssetContext | null = null;
  let retrieval: QdrantRetrieval | null = null;
  let contextRetrieval: QdrantRetrieval | null = null;
  let investigation: InvestigationResult | null = null;
  let actionRequest: WorkflowResult["actionRequest"] = null;
  let action: ActionExecutionResult | null = null;
  let verification: VerificationResult | null = null;
  let memoryPersistence: MemoryPersistenceStatus | null = null;
  let assetFromMemory = false;
  let memoryResolutionBasis: MemoryResolutionBasis | null = null;
  let status: WorkflowResult["status"] = "completed";
  let agentRecommendedAction: WorkflowResult["agentRecommendedAction"];
  let actionOverrideReason: WorkflowResult["actionOverrideReason"];
  /** Set only when the action stage ran but produced no request (decline or force failure). */
  let actionStageConsumed = false;
  let error: string | undefined;
  let errorKind: WorkflowResult["errorKind"];
  let errorStatus: number | undefined;

  const finalize = (
    partial: Omit<Parameters<typeof workflowResult>[0], "trace">
  ): WorkflowResult => {
    const trace: WorkflowTrace = buildWorkflowTrace({
      input: normalized,
      status: partial.status,
      asset,
      assetFromMemory,
      memoryResolutionBasis,
      retrieval,
      contextRetrieval,
      steps: partial.steps,
      triage: partial.triage,
      investigation: partial.investigation,
      action: partial.action,
      verification: partial.verification,
      memoryPersistence: partial.memoryPersistence ?? memoryPersistence,
      agentRecommendedAction: agentRecommendedAction ?? null,
      actionOverrideReason: actionOverrideReason ?? null,
      error: partial.error ?? null,
    });
    return workflowResult({ ...partial, trace });
  };

  const triageRun = await runTriage(contextFor(normalized, null, null, null, null, null));
  let triage = triageRun.value;
  steps.push(triageRun.trace);

  if (triage.clarification && triage.intent === "REPORT_ISSUE") {
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage,
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: triage.clarification,
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  const transcriptReferences = explicitAssetReferences(normalized.transcript);
  const metadataReferences = uniqueReferences(metadataAssetReferences(normalized.metadata));
  const explicitReferences = uniqueReferences([...transcriptReferences, ...metadataReferences]);
  let candidate =
    canonicalAssetReference(triage.assetId) ??
    transcriptReferences[0] ??
    metadataReferences[0] ??
    null;
  if (!candidate && triage.intent !== "REPORT_ISSUE") {
    try {
      contextRetrieval = dependencies.retrieveContext
        ? await dependencies.retrieveContext(normalized)
        : await retrieveQdrant(normalized.transcript, { topK: 5 });
      const { candidates, basis } = memoryAssetCandidates(contextRetrieval);
      if (candidates.length === 1) {
        candidate = candidates[0];
        assetFromMemory = true;
        memoryResolutionBasis = basis;
        triage = { ...triage, assetId: candidate };
      }
    } catch {
      contextRetrieval = null;
    }
  }
  if (!candidate) {
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage,
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: clarificationAnswer(triage),
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  if (!assetFromMemory && !isExplicitAssetReference(candidate, normalized)) {
    const clarified = {
      ...triage,
      clarification: "The proposed asset was not explicitly present in the transcript or supplied metadata.",
    };
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage: clarified,
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: clarificationAnswer(clarified),
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  const resolvedReferenceResults = await Promise.all(
    explicitReferences.slice(0, 12).map((reference) => loadAsset(client, reference))
  );
  const resolvedReferences = Array.from(
    new Map(
      resolvedReferenceResults
        .filter((resolved): resolved is OperationalAssetContext => resolved !== null)
        .map((resolved) => [resolved.id, resolved])
    ).values()
  );
  const referencesAreUnambiguous =
    explicitReferences.length <= 1 ||
    (explicitReferences.length <= 12 &&
      resolvedReferenceResults.every((resolved) => resolved !== null) &&
      resolvedReferences.length === 1);
  if (!referencesAreUnambiguous) {
    const clarified = {
      ...triage,
      clarification: "Multiple or unresolved asset references were supplied. Identify the intended FieldOS asset before an action can be taken.",
    };
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage: clarified,
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: clarificationAnswer(clarified),
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  if (resolvedReferences.length === 1) {
    asset = resolvedReferences[0];
    if (candidate && !assetMatches(asset, candidate)) {
      const clarified = {
        ...triage,
        clarification: "The triage asset does not match the explicitly referenced FieldOS asset.",
      };
      status = "clarification_required";
      const workflow = finalize({
        status,
        triage: clarified,
        retrieval: null,
        investigation: null,
        actionRequest: null,
        action: null,
        verification: null,
        steps,
      });
      return {
        answer: clarificationAnswer(clarified),
        evidence: [],
        retrieval: emptyRetrieval(normalized.transcript),
        latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
        model: workflowModel(steps),
        workflow,
      };
    }
  } else {
    asset = await loadAsset(client, candidate);
  }

  if (!asset) {
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage: { ...triage, clarification: `Asset ${candidate} could not be resolved in FieldOS.` },
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: clarificationAnswer(workflow.triage),
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  const triagePlant = triage.plantId?.toUpperCase();
  if (triagePlant && triagePlant !== asset.plant.id.toUpperCase() && triagePlant !== asset.plant.code.toUpperCase()) {
    status = "clarification_required";
    const clarified = {
      ...triage,
      clarification: `The transcript plant does not match the resolved plant for ${asset.code}.`,
    };
    const workflow = finalize({
      status,
      triage: clarified,
      retrieval: null,
      investigation: null,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: clarificationAnswer(clarified),
      evidence: [],
      retrieval: emptyRetrieval(normalized.transcript),
      latency: { llmMs: triageRun.trace.latencyMs, totalMs: elapsedMs(startedAt), workflowMs: elapsedMs(startedAt) },
      model: workflowModel(steps),
      workflow,
    };
  }

  if (dependencies.retrieve) {
    retrieval = await dependencies.retrieve(normalized, asset);
  } else if (contextRetrieval) {
    const relevantDocs = contextRetrieval.docs.filter((doc) => {
      const docAssetId = doc.assetId ?? doc.metadata.asset_id ?? doc.metadata.assetId;
      const docAssetCode = doc.metadata.asset_code;
      return (
        (typeof docAssetId === "string" && docAssetId.toLowerCase() === asset.id.toLowerCase()) ||
        (typeof docAssetCode === "string" && docAssetCode.toUpperCase() === asset.code.toUpperCase())
      );
    });
    retrieval = relevantDocs.length > 0
      ? { ...contextRetrieval, docs: relevantDocs }
      : await retrieveEvidence(normalized, asset);
  } else {
    retrieval = await retrieveEvidence(normalized, asset);
  }

  const investigationContext = contextFor(normalized, triage, asset, retrieval, null, null);
  const investigationRun = await runInvestigation(investigationContext);
  investigation = investigationRun.value;
  steps.push(investigationRun.trace);

  if (investigation.clarification) {
    status = "clarification_required";
    const workflow = finalize({
      status,
      triage,
      retrieval: retrievalInfo(retrieval),
      investigation,
      actionRequest: null,
      action: null,
      verification: null,
      steps,
    });
    return {
      answer: investigation.clarification,
      evidence: evidenceFromRetrieval(retrieval),
      retrieval: retrievalInfo(retrieval),
      latency: {
        llmMs: triageRun.trace.latencyMs + investigationRun.trace.latencyMs,
        totalMs: elapsedMs(startedAt),
        workflowMs: elapsedMs(startedAt),
      },
      model: workflowModel(steps),
      workflow,
    };
  }

  /**
   * Grounding is a property of the deterministic retrieval layer, not of the
   * investigation agent's output. `retrieval` is already narrowed to the
   * resolved asset before the agent runs, so "did the retriever supply at least
   * one above-threshold record for this asset" is decided entirely from Qdrant
   * results. `investigation.supportingEvidence` is free-form prose and is never
   * compared against document identifiers: the agent cannot vouch for its own
   * evidence, and a citation it invents, omits, or paraphrases must not decide
   * whether a database mutation is allowed.
   */
  /**
   * Model A precedence: an explicit, unconditional request to create a work order
   * outranks an investigation that recommended `NO_ACTION` — for example because a
   * work order is already open. The override is applied here, deliberately *before*
   * the grounding gate below, so grounding is evaluated against the effective
   * recommendation rather than being bypassed. The agent's original recommendation
   * is preserved in `agentRecommendedAction` so the override stays visible.
   *
   * This does not weaken any guard. Grounding still forces `NO_ACTION` when no
   * above-threshold evidence exists, asset resolution and the plant check already
   * ran, and `actionAssetMatches` and `expectedAssetId` still apply to whatever the
   * action stage produces. Only `REPORT_ISSUE` is eligible, so a status check or an
   * information request never becomes a mutation.
   */
  const requestedAction = requestedActionFromTranscript(normalized.transcript);
  const explicitCreateOverride =
    triage.intent === "REPORT_ISSUE" &&
    investigation.recommendedAction === "NO_ACTION" &&
    requestedAction === "CREATE_WORK_ORDER";
  if (explicitCreateOverride) {
    agentRecommendedAction = investigation.recommendedAction;
    actionOverrideReason = "explicit_request";
    investigation = { ...investigation, recommendedAction: "CREATE_WORK_ORDER" };
  }

  const forceRequested = metadataForceAction(normalized.metadata);
  const groundedEvidence = retrieval.docs.filter((doc) => doc.score >= MIN_EVIDENCE_SCORE);
  let groundingForcedNoAction = false;
  // Grounding is evaluated whenever an action is being contemplated, which includes
  // the force path. Checking it only against a non-`NO_ACTION` recommendation would
  // let `forceAction` carry a request through with no supporting evidence at all.
  const actionContemplated = investigation.recommendedAction !== "NO_ACTION" || forceRequested;
  if (
    triage.intent === "REPORT_ISSUE" &&
    actionContemplated &&
    groundedEvidence.length === 0
  ) {
    status = "clarification_required";
    groundingForcedNoAction = true;
    investigation = {
      ...investigation,
      recommendedAction: "NO_ACTION",
      clarification: "The proposed action was not supported by a retrieved evidence record.",
    };
  }

  /**
   * Option C authorisation. Every clause is a deterministic precondition, so the
   * action agent can decline a duplicate but cannot veto an explicit, grounded
   * create request:
   *
   * - `explicitCreateOverride` already requires `triage.intent === "REPORT_ISSUE"`,
   *   an investigation that recommended `NO_ACTION`, and a deterministic
   *   `requestedActionFromTranscript(...)` match of `CREATE_WORK_ORDER`;
   * - grounding is re-checked here, because a request that grounding rejected has
   *   no supporting evidence and must stay a clarification, not a write;
   * - `requestedAction` is compared again rather than trusted transitively, so this
   *   authorisation cannot be widened to another action class without a change to
   *   the parser's return type.
   */
  const explicitCreateAuthorized =
    explicitCreateOverride &&
    !groundingForcedNoAction &&
    triage.intent === "REPORT_ISSUE" &&
    requestedAction === "CREATE_WORK_ORDER";

  if (triage.intent !== "REPORT_ISSUE") {
    steps.push(skippedAgentStep("action", "Triage intent is not a report requiring a mutation."));
    steps.push(skippedAgentStep("verification", "No action was executed."));
  } else if (!investigationRequired(triage)) {
    steps.push(skippedAgentStep("action", "This report is not required to reach an action."));
    steps.push(skippedAgentStep("verification", "No action was executed."));
  } else if (actionContemplated && !groundingForcedNoAction) {
    actionStageConsumed = true;
    try {
      const actionRun = await runAction(contextFor(normalized, triage, asset, retrieval, investigation, null));
      steps.push(actionRun.trace);
      const decision = actionRun.value;
      // Exactly one request reaches the shared execution path below, whether it came
      // from the action agent or, under `forceAction` or an explicit create request,
      // from deterministic construction.
      let effectiveRequest: ActionRequest | null = null;

      /**
       * Option C: an explicit, deterministic, grounded create request fixes the
       * permitted action class, so the action agent's `NO_ACTION` is a judgement
       * about duplicates rather than a safety stop. `NEEDS_CLARIFICATION` still
       * stops the run below, and every deterministic guard on the shared path —
       * grounding, asset resolution, `actionAssetMatches`, `assertExpectedAsset`,
       * strict validation, and the read-back verification — still applies unchanged.
       *
       * The substitution reuses the one deterministic builder, so the two paths
       * cannot drift into different validation, and it is reachable only for
       * `CREATE_WORK_ORDER` because that is the sole value
       * `requestedActionFromTranscript` can return.
       */
      if (decision.type === "NO_ACTION" && (forceRequested || explicitCreateAuthorized)) {
        /**
         * `metadata.forceAction` substitutes a deterministically built request for an
         * action agent that declined. Every value comes from already-resolved backend
         * data, and the result flows through the same `actionAssetMatches` and
         * `expectedAssetId` checks as an agent request, so the force path has no weaker
         * validation. `NEEDS_CLARIFICATION` is deliberately not honoured here: it
         * signals missing identifiers, which is a safety condition, so clarification
         * still wins over the force flag and over an explicit create request.
         */
        const mode: DeterministicRequestMode = forceRequested ? "forced" : "explicit_request";
        const forced = forcedWorkOrderRequest({
          asset,
          triage,
          transcript: normalized.transcript,
          existingWorkOrderCodes: investigation.existingWorkOrderCodes,
          code: metadataWorkOrderCode(normalized.metadata),
          mode,
        });
        if (forced.type === "NEEDS_CLARIFICATION") {
          status = "clarification_required";
          investigation = { ...investigation, clarification: forced.clarification };
          steps.push(skippedAgentStep("verification", "The action agent did not select an executable action."));
        } else {
          effectiveRequest = forced;
          agentRecommendedAction ??= investigation.recommendedAction;
          actionOverrideReason ??= mode;
          investigation = { ...investigation, recommendedAction: "CREATE_WORK_ORDER" };
        }
      } else if (decision.type === "NO_ACTION" || decision.type === "NEEDS_CLARIFICATION") {
        if (decision.type === "NEEDS_CLARIFICATION") {
          status = "clarification_required";
          investigation = { ...investigation, clarification: decision.clarification };
        }
        steps.push(skippedAgentStep("verification", "The action agent did not select an executable action."));
      } else {
        if (decision.type === "CREATE_INCIDENT") {
          throw new PipeError("invalid_request", 400, "Incident creation is not an allowed workflow action.");
        }
        effectiveRequest = decision;
      }

      if (effectiveRequest) {
        actionRequest = effectiveRequest;
        if (!actionAssetMatches(actionRequest, asset)) {
          throw new PipeError("invalid_request", 400, "The proposed action does not target the resolved asset.");
        }
        action = await executeActionRequest(actionRequest, {
          client,
          now: dependencies.now,
          expectedAssetId: asset.id,
        });
        const actionVerification = await readActionVerification(client, action);
        const verificationRun = await runVerification(
          contextFor(normalized, triage, asset, retrieval, investigation, action, actionVerification)
        );
        steps.push(verificationRun.trace);
        verification = verificationRun.value;
        if (!actionVerification.persisted || !actionVerification.matches) {
          verification = {
            success: false,
            summary: `Action ${action.code} was not confirmed by a matching persisted FieldOS record.`,
          };
        }
        if (verification.success && action) {
          const memoryInput: AgentMemoryInput = {
            input: normalized,
            asset,
            triage,
            investigation,
            action,
            verification,
          };
          try {
            const persist = dependencies.persistMemory ?? persistAgentMemory;
            memoryPersistence = await persist(memoryInput);
          } catch (caught) {
            const memoryError = caught instanceof PipeError
              ? caught.message
              : "Qdrant memory persistence failed.";
            console.error("[memory] agent-result persistence failed", {
              kind: caught instanceof PipeError ? caught.kind : "internal",
            });
            memoryPersistence = {
              attempted: true,
              persisted: false,
              type: "AGENT_RESULT",
              error: memoryError,
            };
          }
        }
        if (!verification.success) {
          status = "failed";
          error = verification.summary;
        }
      }
    } catch (caught) {
      error = safeErrorMessage(caught);
      errorKind = caught instanceof PipeError ? caught.kind : "internal";
      errorStatus = caught instanceof PipeError ? caught.status : 500;
      status = "failed";
      /**
       * A provider call that completed before failing carries its own step
       * telemetry. Recording it here means an agent that ran and then produced
       * unusable output is traced as attempted-and-failed, instead of being
       * reconstructed downstream as a step that never ran.
       */
      if (caught instanceof PipeError && caught.agentTrace) {
        steps.push(caught.agentTrace);
      }
      verification = action
        ? { success: false, summary: `Action ${action.code} was executed, but verification failed. ${error}` }
        : actionFailureVerification(error);
    }
  } else if (!actionStageConsumed) {
    steps.push(
      skippedAgentStep(
        "action",
        groundingForcedNoAction
          ? "The grounding gate replaced the investigation recommendation with NO_ACTION."
          : investigation.existingWorkOrderCodes.length > 0
            ? `Investigation selected NO_ACTION with existing work orders on record: ${investigation.existingWorkOrderCodes.join(", ")}.`
            : "Investigation selected NO_ACTION."
      )
    );
    steps.push(skippedAgentStep("verification", "No action was executed."));
  }

  const evidence = retrieval ? evidenceFromRetrieval(retrieval) : [];
  const retrievalSummary = retrieval ? retrievalInfo(retrieval) : emptyRetrieval(normalized.transcript);
  const workflow = finalize({
    status,
    triage,
    retrieval: retrieval ? retrievalSummary : null,
    investigation,
    ...(agentRecommendedAction ? { agentRecommendedAction } : {}),
    ...(actionOverrideReason ? { actionOverrideReason } : {}),
    actionRequest,
    action,
    verification,
    memoryPersistence,
    steps,
    ...(error ? { error } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(errorStatus !== undefined ? { errorStatus } : {}),
  });
  const llmMs = steps.reduce((total, step) => total + step.latencyMs, 0);
  const totalMs = elapsedMs(startedAt);

  const overrideReason = actionOverrideReason;
  return {
    answer: answerFrom(
      investigation,
      verification,
      triage,
      asset,
      action,
      agentRecommendedAction,
      overrideReason
    ),
    evidence,
    retrieval: retrievalSummary,
    latency: { llmMs, totalMs, workflowMs: totalMs },
    model: workflowModel(steps),
    workflow,
  };
}
