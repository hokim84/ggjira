import type { WorkerProvider, WorkerRequest, WorkerResult, WorkerRunHooks } from "./provider.js";

/** Test-only provider that never spawns a process. */
export class FakeWorkerProvider implements WorkerProvider {
  constructor(
    private readonly result: WorkerResult,
    private readonly events: string[] = [],
  ) {}

  async run(_request: WorkerRequest, hooks: WorkerRunHooks = {}): Promise<WorkerResult> {
    for (const event of this.events) {
      hooks.onEvent?.(event);
    }
    return this.result;
  }
}

export function fakeSuccessResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    exitReason: "completed",
    isError: false,
    summary: "Fake worker completed successfully.",
    durationMs: 1000,
    exitCode: 0,
    ...overrides,
  };
}

export function fakeFailureResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    exitReason: "nonzero",
    isError: true,
    summary: "Fake worker failed.",
    durationMs: 500,
    exitCode: 1,
    ...overrides,
  };
}

export function fakeTimeoutResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    exitReason: "timeout",
    isError: true,
    summary: "Fake worker timed out.",
    durationMs: 30000,
    exitCode: null,
    ...overrides,
  };
}
