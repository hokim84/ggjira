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

/** A completed implementation report (ADR 0036) with one passing check — what an implement agent
 *  that did its job answers. Planning tests pass their own `structuredOutput` (a plan). */
export function fakeImplementationReport(overrides: Record<string, unknown> = {}) {
  return {
    outcome: "completed",
    summary: "Fake worker completed successfully.",
    scopeDeviations: [],
    verification: [
      {
        acceptance: "The change works",
        status: "pass",
        method: "executed",
        evidence: "npm run test",
      },
    ],
    ...overrides,
  };
}

export function fakeSuccessResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    exitReason: "completed",
    isError: false,
    summary: "Fake worker completed successfully.",
    durationMs: 1000,
    exitCode: 0,
    structuredOutput: fakeImplementationReport(
      overrides.summary ? { summary: overrides.summary } : {},
    ),
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
