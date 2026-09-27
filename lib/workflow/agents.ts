import { z } from "zod";
import {
  chatWithLyzr,
  type LyzrChatResult,
  type LyzrRole,
} from "../lyzr/client";
import { retrieveQdrant, type QdrantRetrieval } from "../qdrant/retrieval";
import {
  PipeError,
  type ActionExecutionResult,
  type ActionVerificationFact,
  type AgentStepTrace,
  type InvestigationResult,
  type NormalizedInvestigationInput,
  type TriageResult,
  type VerificationResult,
} from "../types";
import {
  actionRequestSchema,
  identifierSchema,
  parseActionRequest,
  type ActionRequest,
} from "../actions/validation";
import {
  parseInvestigationResult,
  parseTriageResult,
  parseVerificationResult,
} from "./schemas";

export interface AssetIncidentContext {
  code: string;
  title: string;
  description: string;
  rootCause: string;
  severity: string;
  occurredAt: string;
  resolvedAt: string | null;
}

export interface AssetMaintenanceContext {
  code: string;
  type: string;
  title: string;
  description: string;
  actionTaken: string;
  performedAt: string;
}

export interface AssetWorkOrderContext {
  code: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  scheduledAt: string;
  completedAt: string | null;
  technicianCode: string;
}

export interface AssetSopContext {
  code: string;
  title: string;
  category: string;
  content: string;
}

export interface OperationalAssetContext {
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
  assignedTechnicianCode: string | null;
  openWorkOrderCode: string | null;
  latestIncidentCode: string | null;
  incidents: AssetIncidentContext[];
  maintenanceRecords: AssetMaintenanceContext[];
  workOrders: AssetWorkOrderContext[];
  sops: AssetSopContext[];
}

export interface AgentRoleResult<T> {
  value: T;
  trace: AgentStepTrace;
}

export interface AgentContext {
  input: NormalizedInvestigationInput;
  asset: OperationalAssetContext | null;
  triage: TriageResult | null;
  retrieval: QdrantRetrieval | null;
  investigation: InvestigationResult | null;
  action: ActionExecutionResult | null;
  actionVerification: ActionVerificationFact | null;
}

export type ActionDecision =
  | ActionRequest
  | { type: "NO_ACTION"; reason: string; clarification?: string; assetId?: string }
  | { type: "NEEDS_CLARIFICATION"; reason: string; clarification: string; assetId?: string };

const ASSET_REFERENCE_BOUNDARY = "(?=$|[^A-Z0-9._/-]|\\.(?=$|[^A-Z0-9._/-]))";
const ASSET_CODE_PATTERN = new RegExp(
  `(?<![A-Z0-9._/-])\\b[A-Z]{1,5}-\\d{2,}${ASSET_REFERENCE_BOUNDARY}`,
  "i"
);
const ASSET_UUID_PATTERN = new RegExp(
  `(?<![A-Z0-9._/-])\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${ASSET_REFERENCE_BOUNDARY}`,
  "i"
);

const noActionSchema = z
  .object({
    type: z.literal("NO_ACTION"),
    reason: z.string().trim().min(1).max(4000),
    clarification: z.string().trim().min(1).max(4000).optional(),
    assetId: identifierSchema.optional(),
  })
  .strict();

const clarificationSchema = z
  .object({
    type: z.literal("NEEDS_CLARIFICATION"),
    reason: z.string().trim().min(1).max(4000),
    clarification: z.string().trim().min(1).max(4000),
    assetId: identifierSchema.optional(),
  })
  .strict();

const NO_ACTION_TYPE = "NO_ACTION";
const NEEDS_CLARIFICATION_TYPE = "NEEDS_CLARIFICATION";
const ACTION_TYPE_ALIAS = "actionType";

interface ActionVariantFields {
  readonly fields: ReadonlySet<string>;
  readonly optional: ReadonlySet<string>;
  readonly nullable: ReadonlySet<string>;
}

function readActionVariantFields(
  shape: Record<string, z.ZodType>
): ActionVariantFields {
  const fields = new Set<string>();
  const optional = new Set<string>();
  const nullable = new Set<string>();

  for (const [key, schema] of Object.entries(shape)) {
    if (key === "type") continue;
    fields.add(key);
    if (schema.isOptional()) optional.add(key);
    if (schema.isNullable()) nullable.add(key);
  }

  return { fields, optional, nullable };
}

/**
 * Field ownership per Action variant, read from the production schemas so this
 * boundary adapter can never drift from the domain rules it normalizes for.
 * NO_ACTION and NEEDS_CLARIFICATION are absent from the union and are added
 * from their dedicated schemas.
 */
const ACTION_VARIANT_FIELDS: ReadonlyMap<string, ActionVariantFields> = (() => {
  const variants = new Map<string, ActionVariantFields>();

  for (const option of actionRequestSchema.options) {
    const shape = (option as unknown as { shape: Record<string, z.ZodType> })
      .shape;
    const variant = (shape.type as unknown as z.ZodType & { value: string })
      .value;
    variants.set(variant, readActionVariantFields(shape));
  }

  const dedicated = [
    [NO_ACTION_TYPE, noActionSchema],
    [NEEDS_CLARIFICATION_TYPE, clarificationSchema],
  ] as const;
  for (const [variant, schema] of dedicated) {
    const shape = (schema as unknown as { shape: Record<string, z.ZodType> })
      .shape;
    variants.set(variant, readActionVariantFields(shape));
  }

  return variants;
})();

/** Every field name owned by any Action variant, and nothing else. */
const KNOWN_ACTION_FIELDS: ReadonlySet<string> = new Set(
  Array.from(ACTION_VARIANT_FIELDS.values()).flatMap((variant) =>
    Array.from(variant.fields)
  )
);

/**
 * Reports a rejected Action-agent response once, with the classification the
 * caller will observe and the schema detail that explains the rejection.
 *
 * Only the field path and the Zod reason are logged. The agent payload, the Lyzr
 * API key and any connection string are never logged, and the field path and
 * reason are the same values carried into `WorkflowResult`, so the server log and
 * the response body can never disagree about what was rejected.
 */
function reportMalformedActionOutput(path: string, detail: string): void {
  console.error("[agent:action] Lyzr action response failed action-schema validation", {
    kind: "lyzr_malformed",
    path,
    detail,
  });
}

/**
 * Builds the `PipeError` for an Action decision rejected at the untrusted-Lyzr
 * boundary.
 *
 * The rejected value came from the Action agent, not from the caller, so a schema
 * or discriminator violation is a provider-side failure and is reported as
 * `lyzr_malformed` / 502. That is the classification Triage, Investigation and
 * Verification already use for malformed agent output; the Action role was the
 * only one that reported a bad agent response as an `invalid_request` / 400
 * caller error, which made a provider contract violation look like a bad request.
 *
 * Nothing is coerced, relaxed or accepted: the decision is still rejected, so the
 * boundary stays fail-closed. Genuine caller validation keeps `invalid_request` /
 * 400 in `parseActionRequest`, which is shared with caller-supplied requests.
 */
function invalidActionRequest(path: string, message: string): PipeError {
  reportMalformedActionOutput(path, message);
  return new PipeError(
    "lyzr_malformed",
    502,
    `Invalid action request at ${path}: ${message}.`
  );
}

function invalidActionRequestFromZod(error: z.ZodError): PipeError {
  const issue = error.issues[0];
  if (!issue) return invalidActionRequest("request", "invalid action request");
  const path = issue.path.length > 0 ? issue.path.join(".") : "request";
  return invalidActionRequest(path, issue.message);
}

/**
 * Adapts the untrusted Lyzr structured-output envelope to the production
 * discriminator and field set. This is a boundary adapter only: it never adds,
 * invents, coerces, or relaxes a value, so the returned decision still has to
 * satisfy the unchanged production schemas.
 *
 * Unknown keys are never removed, required-field nulls are never removed, and a
 * non-null value for a field owned by another variant is always preserved, so
 * `.strict()`, the enums, the identifiers and the refinements keep failing
 * closed exactly as they did before.
 */
function normalizeActionEnvelope(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }

  const record = value as Record<string, unknown>;
  const declaredType = record.type;
  const aliasType = record[ACTION_TYPE_ALIAS];

  if (
    declaredType !== undefined &&
    aliasType !== undefined &&
    declaredType !== aliasType
  ) {
    throw invalidActionRequest(
      "type",
      `conflicting "${String(declaredType)}" and "${ACTION_TYPE_ALIAS}" values`
    );
  }

  const type = declaredType ?? aliasType;
  if (typeof type !== "string") return record;

  const variant = ACTION_VARIANT_FIELDS.get(type);
  if (!variant) return { ...record, type };

  const normalized: Record<string, unknown> = { type };

  for (const [key, fieldValue] of Object.entries(record)) {
    if (key === "type" || key === ACTION_TYPE_ALIAS) continue;

    if (!KNOWN_ACTION_FIELDS.has(key)) {
      normalized[key] = fieldValue;
      continue;
    }

    if (!variant.fields.has(key)) {
      if (fieldValue === null) continue;
      normalized[key] = fieldValue;
      continue;
    }

    if (
      fieldValue === null &&
      variant.optional.has(key) &&
      !variant.nullable.has(key)
    ) {
      continue;
    }

    normalized[key] = fieldValue;
  }

  return normalized;
}

export function parseActionDecision(value: unknown): ActionDecision {
  const normalized = normalizeActionEnvelope(value);

  if (
    typeof normalized === "object" &&
    normalized !== null &&
    "type" in normalized
  ) {
    const type = (normalized as { type?: unknown }).type;
    if (type === NO_ACTION_TYPE) {
      const parsed = noActionSchema.safeParse(normalized);
      if (parsed.success) return parsed.data;
      throw invalidActionRequestFromZod(parsed.error);
    }
    if (type === NEEDS_CLARIFICATION_TYPE) {
      const parsed = clarificationSchema.safeParse(normalized);
      if (parsed.success) return parsed.data;
      throw invalidActionRequestFromZod(parsed.error);
    }
  }

  try {
    return parseActionRequest(normalized);
  } catch (error) {
    /**
     * `parseActionRequest` is shared with caller-supplied action requests, where a
     * violation is correctly an `invalid_request`. Here the value is untrusted
     * Action-agent output, so the same violation is re-classified as
     * `lyzr_malformed` and the validation message is carried over unchanged. The
     * field path is already inside the message, so it is not re-parsed.
     */
    if (error instanceof PipeError && error.kind === "invalid_request") {
      reportMalformedActionOutput("request", error.message);
      throw new PipeError("lyzr_malformed", 502, error.message);
    }
    throw error;
  }
}

function trace(role: LyzrRole, response: LyzrChatResult): AgentStepTrace {
  return {
    role,
    status: "completed",
    provider: response.provider,
    mock: response.mock,
    latencyMs: response.latencyMs,
  };
}

function skippedTrace(role: LyzrRole, reason: string): AgentStepTrace {
  return {
    role,
    status: "skipped",
    mock: false,
    latencyMs: 0,
    error: reason,
  };
}

/**
 * Records an agent that reached its provider and then failed, keeping the
 * provider, mock/live state and measured latency that `skippedTrace` would
 * discard. Without this an agent that ran and produced unusable output is
 * reported as a step that never ran.
 */
function failedTrace(
  role: LyzrRole,
  response: LyzrChatResult,
  reason: string
): AgentStepTrace {
  return {
    role,
    status: "failed",
    provider: response.provider,
    mock: response.mock,
    latencyMs: response.latencyMs,
    error: reason,
  };
}

export function parseAgentJson(content: string): unknown {
  const trimmed = content.trim();
  const candidates: string[] = [];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new PipeError("lyzr_malformed", 502, "Lyzr returned non-JSON content for a structured role.");
}

function promptUserId(input: NormalizedInvestigationInput): string | undefined {
  const value = input.metadata.userId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requestIdentity(input: NormalizedInvestigationInput): { userId?: string; sessionId?: string } {
  return {
    userId: promptUserId(input),
    sessionId: input.sessionId ?? undefined,
  };
}

const JSON_ONLY_INSTRUCTION = "Return ONLY a single JSON object. No prose, no markdown fences.";

function triagePrompt(input: NormalizedInvestigationInput): string {
  return [
    "You are the FieldOS triage agent.",
    "Return one JSON object only with keys intent, assetId, plantId, issue, severity, requiresInvestigation, and optional clarification.",
    "Use only the transcript and explicitly supplied metadata. Do not invent an asset, plant, severity, or issue.",
    "Allowed intent values: REPORT_ISSUE, CHECK_STATUS, REQUEST_INFORMATION.",
    "Allowed severity values: LOW, MEDIUM, HIGH, CRITICAL.",
    `TRANSCRIPT: ${input.transcript}`,
    `METADATA: ${JSON.stringify(input.metadata)}`,
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

function investigationPrompt(context: AgentContext): string {
  return [
    "You are the FieldOS investigation agent.",
    "Return one JSON object only with keys findings, probableIssue, supportingEvidence, recommendedAction, and rationale.",
    "Use only the transcript, resolved asset context, and retrieved evidence. Do not invent facts or execute actions.",
    "Allowed recommendedAction values: CREATE_WORK_ORDER, UPDATE_WORK_ORDER, ESCALATE_INCIDENT, RECORD_OBSERVATION, NO_ACTION.",
    "When existing open work orders are relevant to the asset, list their work-order codes in existingWorkOrderCodes instead of encoding the conflict only in rationale. The existence of an open work order is evidence, not an automatic veto of an explicit user request.",
    `TRANSCRIPT: ${context.input.transcript}`,
    `TRIAGE: ${JSON.stringify(context.triage)}`,
    `ASSET_CONTEXT: ${JSON.stringify(context.asset)}`,
    `RETRIEVAL: ${JSON.stringify(context.retrieval)}`,
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

function actionPrompt(context: AgentContext): string {
  return [
    "You are the FieldOS constrained action agent.",
    "Return one JSON object only. It must include type and reason and may contain only the fields allowed for that action type.",
    "Allowed types: CREATE_WORK_ORDER, UPDATE_WORK_ORDER, ESCALATE_INCIDENT, RECORD_OBSERVATION, NO_ACTION, NEEDS_CLARIFICATION. Emit only one of these.",
    "Exact fields each action schema defines, so you do not have to infer the contract. A * marks a required field:",
    "CREATE_WORK_ORDER: *assetId, *title, *description, *reason, *priority, code, technicianId, status, scheduledAt, completedAt",
    "UPDATE_WORK_ORDER: *reason, workOrderId, workOrderCode, assetId, title, description, technicianId, priority, status, scheduledAt, completedAt",
    "RECORD_OBSERVATION: *assetId, *title, *description, *reason, code, technicianId, actionTaken, performedAt",
    "ESCALATE_INCIDENT: *reason, *severity, incidentId, incidentCode",
    "NO_ACTION: *reason, clarification, assetId",
    "NEEDS_CLARIFICATION: *reason, *clarification, assetId",
    "CREATE_INCIDENT: *assetId, *title, *description, *rootCause, *reason, *severity, code, technicianId, occurredAt, resolvedAt",
    "Any field not listed for the chosen type is rejected as an unknown key and the whole response is discarded as a malformed action.",
    "CREATE_WORK_ORDER and RECORD_OBSERVATION require assetId. UPDATE_WORK_ORDER accepts an optional assetId. NO_ACTION and NEEDS_CLARIFICATION may optionally carry assetId to name the asset they concern, and otherwise use only the fields listed for them. ESCALATE_INCIDENT does not accept assetId, so identify the incident with incidentId or incidentCode instead. UPDATE_WORK_ORDER and ESCALATE_INCIDENT each need at least one of their listed identifier fields.",
    "Creating an incident is not an available workflow action, so never return CREATE_INCIDENT; its row above only shows the field set its schema defines.",
    "Use NO_ACTION or NEEDS_CLARIFICATION when required identifiers or information are missing.",
    "Existing open work orders are evidence, not an automatic veto of an explicit user request: if the transcript asked for a new work order and the recommendation is CREATE_WORK_ORDER, create it even when an open work order already covers the asset, and record the overlapping codes in your reason. Return NEEDS_CLARIFICATION instead when an identifier you would need is genuinely absent. Do not return NO_ACTION merely to avoid a duplicate.",
    "You do not have the final say. Grounding, asset resolution, and the backend action guards are applied after you answer, and a declined explicit create request is created deterministically by application policy. Do not return SQL, Prisma calls, arbitrary fields, or an action when required identifiers are unresolved.",
    "Use the assetId field, which may hold the asset code (for example P-204) or the asset UUID when the supplied context provides one. Never emit an assetCode field; do not invent identifiers.",
    `TRANSCRIPT: ${context.input.transcript}`,
    `TRIAGE: ${JSON.stringify(context.triage)}`,
    `INVESTIGATION: ${JSON.stringify(context.investigation)}`,
    `ASSET_CONTEXT: ${JSON.stringify(context.asset)}`,
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

function verificationPrompt(context: AgentContext): string {
  return [
    "You are the FieldOS verification agent.",
    "Return one JSON object only, and no other top-level keys. An unlisted key rejects the whole response.",
    "success is a JSON boolean. summary is a non-empty string.",
    "memoryCandidate is optional: omit it or set it to null when there is no memory candidate. Otherwise it is an object with exactly two non-empty string fields, text and sourceId, and no other keys.",
    "Verify only the actual deterministic action result. Do not claim an action succeeded unless actionResult is present and reports execution.",
    `TRANSCRIPT: ${context.input.transcript}`,
    `INVESTIGATION: ${JSON.stringify(context.investigation)}`,
    `ACTION_RESULT: ${JSON.stringify(context.action)}`,
    `PERSISTED_ACTION_CHECK: ${JSON.stringify(context.actionVerification)}`,
    JSON_ONLY_INSTRUCTION,
  ].join("\n");
}

async function runStructuredRole<T>(
  role: LyzrRole,
  prompt: string,
  context: AgentContext,
  parse: (value: unknown) => T,
  mock: () => T
): Promise<AgentRoleResult<T>> {
  const response = await chatWithLyzr({
    role,
    message: prompt,
    ...requestIdentity(context.input),
  });
  const rawValue = response.mock ? mock() : parseAgentJson(response.content);
  const value = parse(rawValue);
  return { value, trace: trace(role, response) };
}

function assetCodeFromText(text: string): string | null {
  return text.match(ASSET_CODE_PATTERN)?.[0]?.toUpperCase() ?? null;
}

function assetReferenceFromText(text: string): string | null {
  return (
    assetCodeFromText(text) ??
    text.match(ASSET_UUID_PATTERN)?.[0]?.toLowerCase() ??
    null
  );
}

function metadataAssetId(input: NormalizedInvestigationInput): string | null {
  const structured =
    typeof input.metadata.structured === "object" && input.metadata.structured !== null && !Array.isArray(input.metadata.structured)
      ? (input.metadata.structured as Record<string, unknown>)
      : null;
  const values = [
    input.metadata.assetId,
    input.metadata.asset_id,
    input.metadata.assetCode,
    input.metadata.asset_code,
    structured?.assetId,
    structured?.asset_id,
    structured?.assetCode,
    structured?.asset_code,
  ];
  const value = values.find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0);
  return value?.trim() ?? null;
}

function severityFromText(text: string): TriageResult["severity"] {
  const normalized = text.toLowerCase();
  if (/\b(fire|smoke|shutdown|critical|burst|flood)\b/.test(normalized)) return "CRITICAL";
  if (/\b(vibration|leak|overheat|fault|damaged|abnormal)\b/.test(normalized)) return "HIGH";
  if (/\b(pressure|temperature|noise|warning|rattle)\b/.test(normalized)) return "MEDIUM";
  return "LOW";
}

function mockTriage(input: NormalizedInvestigationInput): TriageResult {
  const text = input.transcript;
  const assetId = assetReferenceFromText(text) ?? metadataAssetId(input);
  const normalized = text.toLowerCase();
  const intent: TriageResult["intent"] = /\b(status|open|closed|progress|check)\b/.test(normalized)
    ? "CHECK_STATUS"
    : /\b(information|what|how|tell me|explain)\b/.test(normalized)
      ? "REQUEST_INFORMATION"
      : "REPORT_ISSUE";
  const severity = severityFromText(text);
  const issue = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  return {
    intent,
    assetId,
    plantId: null,
    issue,
    severity,
    requiresInvestigation: intent === "REPORT_ISSUE" && Boolean(assetId),
  };
}

function mockInvestigation(context: AgentContext): InvestigationResult {
  const triage = context.triage!;
  const docs = (context.retrieval?.docs ?? []).filter((doc) => doc.score >= 0.25);
  const action = triage.intent === "REPORT_ISSUE" && triage.requiresInvestigation && docs.length > 0;
  return {
    findings: action
      ? [`The report identifies a condition for ${context.asset?.code ?? triage.assetId ?? "the referenced asset"}.`, `${docs.length} relevant operational record${docs.length === 1 ? "" : "s"} were retrieved.`]
      : ["The available evidence does not establish a safe database-changing action."],
    probableIssue: triage.issue,
    supportingEvidence: docs.map((doc) => doc.id),
    recommendedAction: action ? "CREATE_WORK_ORDER" : "NO_ACTION",
    rationale: action
      ? "A reported field condition with relevant operational evidence warrants a constrained follow-up action."
      : "No sufficiently grounded action was selected.",
    existingWorkOrderCodes: [],
  };
}

function mockAction(context: AgentContext): ActionDecision {
  const triage = context.triage!;
  const investigation = context.investigation!;
  const asset = context.asset;
  const assetId = asset?.code ?? triage.assetId;
  if (!assetId) {
    return {
      type: "NEEDS_CLARIFICATION",
      reason: "The action has no explicitly resolved asset.",
      clarification: "An explicit asset code is required before an action can be executed.",
    };
  }
  const priority = triage.severity ?? "MEDIUM";
  const description = `Field report: ${context.input.transcript}`.slice(0, 10000);
  const reason = "The investigation selected a constrained follow-up from the field report.";

  if (investigation.recommendedAction === "CREATE_WORK_ORDER") {
    return parseActionRequest({
      type: "CREATE_WORK_ORDER",
      assetId,
      title: `Inspect ${assetId}: reported condition`,
      description,
      reason,
      priority,
      status: "OPEN",
      scheduledAt: context.input.timestamp,
      ...(asset?.assignedTechnicianCode ? { technicianId: asset.assignedTechnicianCode } : {}),
    });
  }

  if (investigation.recommendedAction === "RECORD_OBSERVATION") {
    return parseActionRequest({
      type: "RECORD_OBSERVATION",
      assetId,
      title: `Observation for ${assetId}`,
      description,
      reason,
      performedAt: context.input.timestamp,
      ...(asset?.assignedTechnicianCode ? { technicianId: asset.assignedTechnicianCode } : {}),
    });
  }

  if (investigation.recommendedAction === "UPDATE_WORK_ORDER") {
    if (!asset?.openWorkOrderCode) {
      return {
        type: "NEEDS_CLARIFICATION",
        reason: "No open work order is available for update.",
        clarification: "No open work order was found for the resolved asset.",
      };
    }
    return parseActionRequest({
      type: "UPDATE_WORK_ORDER",
      workOrderCode: asset.openWorkOrderCode,
      reason,
      priority,
      status: "IN_PROGRESS",
    });
  }

  if (investigation.recommendedAction === "ESCALATE_INCIDENT") {
    if (!asset?.latestIncidentCode) {
      return {
        type: "NEEDS_CLARIFICATION",
        reason: "No incident is available for escalation.",
        clarification: "No incident was found for the resolved asset.",
      };
    }
    return parseActionRequest({
      type: "ESCALATE_INCIDENT",
      incidentCode: asset.latestIncidentCode,
      reason,
      severity: priority,
    });
  }

  return {
    type: "NO_ACTION",
    reason: "The selected action is not executable from the resolved context.",
  };
}

function mockVerification(context: AgentContext): VerificationResult {
  const action = context.action;
  if (!action) throw new PipeError("invalid_request", 400, "Verification requires an action result.");
  if (!context.actionVerification?.persisted || !context.actionVerification.matches) {
    return {
      success: false,
      summary: `Action ${action.code} was not confirmed by a matching persisted FieldOS record.`,
    };
  }
  return {
    success: true,
    summary: `${action.summary} ${action.code} was written for ${action.assetCode}.`,
  };
}

export async function runTriage(context: AgentContext): Promise<AgentRoleResult<TriageResult>> {
  return runStructuredRole(
    "triage",
    triagePrompt(context.input),
    context,
    parseTriageResult,
    () => mockTriage(context.input)
  );
}

export async function runInvestigation(context: AgentContext): Promise<AgentRoleResult<InvestigationResult>> {
  return runStructuredRole(
    "investigation",
    investigationPrompt(context),
    context,
    parseInvestigationResult,
    () => mockInvestigation(context)
  );
}

export async function runAction(context: AgentContext): Promise<AgentRoleResult<ActionDecision>> {
  return runStructuredRole(
    "action",
    actionPrompt(context),
    context,
    parseActionDecision,
    () => mockAction(context)
  );
}

/**
 * Runs the Verification agent and, when the provider response cannot be parsed,
 * rethrows the same `PipeError` carrying the step telemetry for the call that was
 * actually made.
 *
 * The `kind`/`status`/`message` are preserved unchanged, so a rejected provider
 * response is still `lyzr_malformed` / 502, and only the observability data is
 * added. This deliberately does not reuse `runStructuredRole`: the other three
 * roles keep their existing error surface unchanged.
 */
export async function runVerification(context: AgentContext): Promise<AgentRoleResult<VerificationResult>> {
  const response = await chatWithLyzr({
    role: "verification",
    message: verificationPrompt(context),
    ...requestIdentity(context.input),
  });

  try {
    const rawValue = response.mock ? mockVerification(context) : parseAgentJson(response.content);
    return { value: parseVerificationResult(rawValue), trace: trace("verification", response) };
  } catch (caught) {
    if (caught instanceof PipeError) {
      throw new PipeError(
        caught.kind,
        caught.status,
        caught.message,
        failedTrace("verification", response, caught.message)
      );
    }
    throw caught;
  }
}

export function skippedAgentStep(role: LyzrRole, reason: string): AgentStepTrace {
  return skippedTrace(role, reason);
}

export async function retrieveEvidence(
  input: NormalizedInvestigationInput,
  asset: OperationalAssetContext,
  retrievalClient?: Parameters<typeof retrieveQdrant>[2]
): Promise<QdrantRetrieval> {
  const query = [input.transcript, asset.code, asset.name, triageIssue(input.transcript)]
    .filter(Boolean)
    .join(" ");
  return retrieveQdrant(
    query,
    {
      topK: 5,
      assetId: asset.id,
      assetCode: asset.code,
      plantId: asset.plant.id,
      plantCode: asset.plant.code,
    },
    retrievalClient
  );
}

function triageIssue(text: string): string {
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}
