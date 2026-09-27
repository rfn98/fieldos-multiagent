import { z } from "zod";
import { PipeError } from "../types";

const dateSchema = z
  .union([z.string().trim().min(1), z.date()])
  .refine(
    (value) => {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isFinite(date.getTime());
    },
    { message: "must be a valid ISO date" }
  )
  .transform((value) => (value instanceof Date ? value : new Date(value)));

const optionalDateSchema = dateSchema.optional();
const nullableDateSchema = dateSchema.nullable().optional();
const codeSchema = z.string().trim().min(1).max(80).optional();
export const identifierSchema = z.string().trim().min(1).max(120);
const textSchema = z.string().trim().min(1).max(10000);
const reasonSchema = z.string().trim().min(1).max(4000);
const prioritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const severitySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const workOrderStatusSchema = z.enum(["OPEN", "IN_PROGRESS", "COMPLETED", "CANCELLED"]);

const createWorkOrderSchema = z
  .object({
    type: z.literal("CREATE_WORK_ORDER"),
    assetId: identifierSchema,
    title: textSchema,
    description: textSchema,
    reason: reasonSchema,
    code: codeSchema,
    technicianId: identifierSchema.optional(),
    priority: prioritySchema,
    status: workOrderStatusSchema.optional(),
    scheduledAt: optionalDateSchema,
    completedAt: nullableDateSchema,
  })
  .strict();

const updateWorkOrderSchema = z
  .object({
    type: z.literal("UPDATE_WORK_ORDER"),
    reason: reasonSchema,
    workOrderId: identifierSchema.optional(),
    workOrderCode: identifierSchema.optional(),
    assetId: identifierSchema.optional(),
    title: textSchema.optional(),
    description: textSchema.optional(),
    technicianId: identifierSchema.optional(),
    priority: prioritySchema.optional(),
    status: workOrderStatusSchema.optional(),
    scheduledAt: optionalDateSchema,
    completedAt: nullableDateSchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.workOrderId || value.workOrderCode),
    { message: "requires workOrderId or workOrderCode" }
  )
  .refine(
    (value) =>
      Boolean(
        value.assetId ||
          value.title ||
          value.description ||
          value.technicianId ||
          value.priority ||
          value.status ||
          value.scheduledAt ||
          value.completedAt !== undefined
      ),
    { message: "requires at least one mutable field" }
  );

const createIncidentSchema = z
  .object({
    type: z.literal("CREATE_INCIDENT"),
    assetId: identifierSchema,
    title: textSchema,
    description: textSchema,
    rootCause: textSchema,
    reason: reasonSchema,
    severity: severitySchema,
    code: codeSchema,
    technicianId: identifierSchema.optional(),
    occurredAt: optionalDateSchema,
    resolvedAt: nullableDateSchema,
  })
  .strict();

const recordObservationSchema = z
  .object({
    type: z.literal("RECORD_OBSERVATION"),
    assetId: identifierSchema,
    title: textSchema,
    description: textSchema,
    reason: reasonSchema,
    code: codeSchema,
    technicianId: identifierSchema.optional(),
    actionTaken: textSchema.optional(),
    performedAt: optionalDateSchema,
  })
  .strict();

const escalateIncidentSchema = z
  .object({
    type: z.literal("ESCALATE_INCIDENT"),
    reason: reasonSchema,
    incidentId: identifierSchema.optional(),
    incidentCode: identifierSchema.optional(),
    severity: severitySchema,
  })
  .strict()
  .refine(
    (value) => Boolean(value.incidentId || value.incidentCode),
    { message: "requires incidentId or incidentCode" }
  );

export const actionRequestSchema = z.discriminatedUnion("type", [
  createWorkOrderSchema,
  updateWorkOrderSchema,
  createIncidentSchema,
  recordObservationSchema,
  escalateIncidentSchema,
]);

export type ActionRequest = z.infer<typeof actionRequestSchema>;

export function parseActionRequest(value: unknown): ActionRequest {
  const result = actionRequestSchema.safeParse(value);
  if (result.success) return result.data;

  const issue = result.error.issues[0];
  const path = issue?.path.length ? issue.path.join(".") : "request";
  const message = issue?.message ?? "invalid action request";
  throw new PipeError("invalid_request", 400, `Invalid action request at ${path}: ${message}.`);
}
