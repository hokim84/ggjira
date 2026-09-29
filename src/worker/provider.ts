import type { ProviderUsageWindow } from "../contracts/api.js";

export interface WorkerRequest {
  /** The task instruction passed to the CLI as its prompt. */
  prompt: string;
  /** Working directory the CLI should run in (a git worktree). */
  cwd: string;
  timeoutMs: number;
  /** Role-specific instructions layered on top of the CLI's default system prompt. */
  systemPrompt?: string;
  /** When set, the provider asks the CLI for a final answer matching this JSON Schema. */
  outputSchema?: unknown;
  /** Restricts the run to non-mutating tools (used by planning/analysis roles). */
  readOnly?: boolean;
}

export type WorkerExitReason = "completed" | "timeout" | "crashed" | "nonzero";

export interface WorkerResult {
  exitReason: WorkerExitReason;
  isError: boolean;
  summary: string;
  durationMs: number;
  exitCode: number | null;
  sessionId?: string;
  totalCostUsd?: number;
  numTurns?: number;
  /** Parsed from the CLI's final answer when `WorkerRequest.outputSchema` was set. */
  structuredOutput?: unknown;
}

export interface WorkerRunHooks {
  signal?: AbortSignal;
  /** Called with each raw stdout line as it arrives (for logging to worker.jsonl). */
  onEvent?: (rawLine: string) => void;
  /** Called with the plan usage the CLI reported during (or right after) the run. */
  onUsage?: (usage: UsageReading) => void;
}

/** A provider's plan usage as its CLI reports it (ADR 0028). */
export interface UsageReading {
  status?: string;
  planType?: string;
  windows: ProviderUsageWindow[];
  error?: string;
}

export interface WorkerProvider {
  run(request: WorkerRequest, hooks?: WorkerRunHooks): Promise<WorkerResult>;
  /** Reads plan usage outside a job, for the worker's first connection. Never throws. */
  readUsage?(): Promise<UsageReading>;
}
