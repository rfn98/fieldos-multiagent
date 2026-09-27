import { z } from "zod";
import {
  PipeError,
  type InvestigationResult,
  type TriageResult,
  type VerificationResult,
} from "../types";

const triageSchema = z.object({
  intent: z.enum(["REPORT_ISSUE", "CHECK_STATUS", "REQUEST_INFORMATION"]),
  assetId: z.string().trim().min(1).nullable().optional(),
  plantId: z.string().trim().min(1).nullable().optional(),
  issue: z.string().trim().min(1).nullable().optional(),
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).nullable().optional(),
  requiresInvestigation: z.boolean().optional().default(false),
  clarification: z.string().trim().min(1).nullable().optional(),
}).strict();

const investigationSchema = z.object({
  findings: z.array(z.string().trim().min(1)).min(1).max(20),
  probableIssue: z.string().trim().min(1).nullable().optional(),
  supportingEvidence: z.array(z.string().trim().min(1)).max(20).default([]),
  recommendedAction: z.enum([
    "CREATE_WORK_ORDER",
    "UPDATE_WORK_ORDER",
    "ESCALATE_INCIDENT",
    "RECORD_OBSERVATION",
    "NO_ACTION",
  ]),
  rationale: z.string().trim().min(1).max(10000),
  existingWorkOrderCodes: z.array(z.string().trim().min(1)).max(20).default([]),
  clarification: z.string().trim().min(1).nullable().optional(),
}).strict();

const memoryCandidateSchema = z
  .object({
    text: z.string().trim().min(1).max(10000),
    sourceId: z.string().trim().min(1).max(200),
  })
  .strict();

const verificationSchema = z.object({
  success: z.boolean(),
  summary: z.string().trim().min(1).max(10000),
  memoryCandidate: memoryCandidateSchema.nullable().optional(),
}).strict();

function malformed(message: string): never {
  throw new PipeError("lyzr_malformed", 502, message);
}

/** Bounds how many rejected paths a provider response can report. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Renders the structural reason a provider response was rejected, as
 * `path: message` pairs.
 *
 * Only the field path and the Zod reason are reported. Zod messages describe
 * expected and received types, never field values, so an offending value, a
 * prompt, or any credential cannot reach the error surface through this path.
 */
function describeIssues(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_REPORTED_ISSUES);
  const rendered = shown.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "response";
    return `${path}: ${issue.message}`;
  });
  const hidden = error.issues.length - shown.length;
  return hidden > 0 ? `${rendered.join("; ")}; +${hidden} more` : rendered.join("; ");
}

export function parseTriageResult(value: unknown): TriageResult {
  const result = triageSchema.safeParse(value);
  if (!result.success) malformed("Lyzr triage returned an invalid response.");
  return {
    intent: result.data.intent,
    assetId: result.data.assetId ?? null,
    plantId: result.data.plantId ?? null,
    issue: result.data.issue ?? null,
    severity: result.data.severity ?? null,
    requiresInvestigation: result.data.requiresInvestigation,
    ...(result.data.clarification ? { clarification: result.data.clarification } : {}),
  };
}

export function parseInvestigationResult(value: unknown): InvestigationResult {
  const result = investigationSchema.safeParse(value);
  if (!result.success) malformed("Lyzr investigation returned an invalid response.");
  return {
    findings: result.data.findings,
    probableIssue: result.data.probableIssue ?? null,
    supportingEvidence: result.data.supportingEvidence,
    recommendedAction: result.data.recommendedAction,
    rationale: result.data.rationale,
    existingWorkOrderCodes: result.data.existingWorkOrderCodes,
    ...(result.data.clarification ? { clarification: result.data.clarification } : {}),
  };
}

export function parseVerificationResult(value: unknown): VerificationResult {
  const result = verificationSchema.safeParse(value);
  if (!result.success) {
    malformed(
      `Lyzr verification returned an invalid response: ${describeIssues(result.error)}`
    );
  }
  return {
    success: result.data.success,
    summary: result.data.summary,
    ...(result.data.memoryCandidate ? { memoryCandidate: result.data.memoryCandidate } : {}),
  };
}
