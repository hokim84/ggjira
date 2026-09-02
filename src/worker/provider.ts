export type WorkerEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerRequest {
  /** The task instruction passed to the CLI as its prompt. */
  prompt: string;
  /** Working directory the CLI should run in (a git worktree). */
  cwd: string;
  timeoutMs: number;
  command: string;
  model: string;
  effort: WorkerEffort;
  permissionMode: string;
  allowedTools: string[];
  appendSystemPrompt?: string;
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
}

export interface WorkerRunHooks {
  signal?: AbortSignal;
  /** Called with each raw stdout line as it arrives (for logging to worker.jsonl). */
  onEvent?: (rawLine: string) => void;
}

export interface WorkerProvider {
  run(request: WorkerRequest, hooks?: WorkerRunHooks): Promise<WorkerResult>;
}
