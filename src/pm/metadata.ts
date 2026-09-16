import { z } from "zod";
import type { JiraGateway } from "../jira/gateway.js";

export const PLAN_PROPERTY_KEY = "ggjira.plan";
export const PLAN_TASK_PROPERTY_KEY = "ggjira.plan-task";

export const PlanMetadataSchema = z.object({
  version: z.string().min(1),
  status: z.enum(["review", "approved"]),
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

export async function readPlanTaskMetadata(
  jira: JiraGateway,
  issueKey: string,
): Promise<PlanTaskMetadata | null> {
  const raw = await jira.getIssueProperty(issueKey, PLAN_TASK_PROPERTY_KEY);
  const parsed = PlanTaskMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
