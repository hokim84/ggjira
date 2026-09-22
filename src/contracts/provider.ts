import { z } from "zod";

/**
 * Provider execution options, shared by the worker-side config and (once the
 * job envelope carries a `providerId`) whatever resolves it to an actual CLI
 * invocation. Kept separate from the legacy `src/config.ts` copy of this
 * shape — that one stays with the v2-v4 code path it belongs to until stage
 * 5 removes it (CLAUDE.md directory rule; docs/router-service-implementation-plan.md §4).
 */
export const ClaudeCodeProviderOptionsSchema = z.object({
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).default("high"),
  permissionMode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"])
    .default("acceptEdits"),
  allowedTools: z.array(z.string()).default(["Edit", "Write", "Read", "Glob", "Grep"]),
});

export const CodexProviderOptionsSchema = z.object({
  sandbox: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
});

/** One entry in a worker's `providers` list; `id` is what Router's job envelope
 *  refers to as `providerId` (docs/router-service-implementation-plan.md "Worker Runtime": "Router는
 *  repositoryId와 providerId를 지정하고, 실제 경로·실행 명령은 워커 설정에서 결정한다"). */
export const WorkerProviderConfigSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(["claude-code", "codex"]).default("claude-code"),
    command: z.string().min(1).optional(),
    model: z.string().min(1).default("sonnet"),
    timeoutMs: z
      .number()
      .int()
      .positive()
      .default(30 * 60 * 1000),
    claudeCode: ClaudeCodeProviderOptionsSchema.default({}),
    codex: CodexProviderOptionsSchema.default({}),
  })
  .transform((provider) => ({
    ...provider,
    command: provider.command ?? (provider.type === "codex" ? "codex" : "claude"),
  }));
export type WorkerProviderConfig = z.infer<typeof WorkerProviderConfigSchema>;
