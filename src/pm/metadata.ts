import { z } from "zod";
import type { JiraGateway } from "../jira/gateway.js";

export const PLAN_PROPERTY_KEY = "ggjira.plan";
export const PLAN_TASK_PROPERTY_KEY = "ggjira.plan-task";

export const PlanMetadataSchema = z.object({
  version: z.string().min(1),
  taskIds: z.array(z.string().min(1)),
  decisionId: z.string().min(1).optional(),
});

export const PlanTaskMetadataSchema = z.object({
  planVersion: z.string().min(1),
  taskId: z.string().min(1),
  parentKey: z.string().min(1),
  workspaceId: z.string().min(1),
  dependencies: z.array(z.string().min(1)).default([]),
});

export type PlanMetadata = z.infer<typeof PlanMetadataSchema>;
export type PlanTaskMetadata = z.infer<typeof PlanTaskMetadataSchema>;

/** Thrown when a `ggjira.plan-task` property exists but doesn't match the schema -- distinct from
 *  the property being absent, so callers can fail closed instead of treating corrupted metadata
 *  the same as "not a distributed task". */
export class PlanMetadataError extends Error {}

/**
 * Returns `null` only when the issue genuinely has no `ggjira.plan-task` property (a manually
 * created task, exempt from distribution gating). A property that exists but fails to parse
 * throws instead of returning `null`, so gating checks don't silently bypass on corrupted data.
 */
export async function readPlanTaskMetadata(
  jira: JiraGateway,
  issueKey: string,
): Promise<PlanTaskMetadata | null> {
  const raw = await jira.getIssueProperty(issueKey, PLAN_TASK_PROPERTY_KEY);
  if (raw === null) return null;
  const parsed = PlanTaskMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PlanMetadataError(
      `${issueKey}'s ${PLAN_TASK_PROPERTY_KEY} property doesn't match the expected shape: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}
