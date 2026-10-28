import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const AssemblyContextSchema = z.object({
  cycleId: z.string().min(1),
  planVersion: z.string().min(1),
  parentKey: z.string().min(1),
  baseBranch: z.string().min(1),
  previousBranch: z.string().optional(),
  replacedPullRequests: z
    .array(
      z.object({ repo: z.string(), number: z.number().int().positive(), url: z.string().url() }),
    )
    .optional(),
  children: z
    .array(
      z.object({
        issueKey: z.string(),
        resultId: z.string(),
        baseSha: sha,
        headSha: sha,
        branch: z.string().optional(),
        noChange: z.boolean(),
        dependencies: z.array(z.string()),
        integratedMergeSha: sha.optional(),
      }),
    )
    .min(1),
});
export type AssemblyContext = z.infer<typeof AssemblyContextSchema>;
