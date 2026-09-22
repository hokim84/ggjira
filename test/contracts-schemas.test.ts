import { describe, expect, it } from "vitest";
import {
  JobResultRequestSchema,
  JobsNextRequestSchema,
  WorkerRegisterRequestSchema,
} from "../src/contracts/api.js";
import {
  IssueSnapshotSchema,
  JobEnvelopeSchema,
  JobResultSchema,
} from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import { WorkerProviderConfigSchema } from "../src/contracts/provider.js";
import { isRouteDispatch, RouteResultSchema } from "../src/contracts/route.js";

function validIssueSnapshot() {
  return {
    key: "KAN-1",
    id: "10001",
    summary: "Do the thing",
    description: null,
    statusName: "AI 작업 요청",
    labels: [],
    assigneeAccountId: null,
    issueTypeName: "Task",
    parentKey: null,
    projectKey: "KAN",
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "job-1",
    attemptId: "attempt-1",
    leaseToken: "lease-token",
    workspaceId: "ws-1",
    repositoryId: "repo-1",
    kind: "implementation",
    providerId: "claude-default",
    approvalId: "approval-1",
    inputHash: "hash-abc",
    issueSnapshot: validIssueSnapshot(),
    systemPrompt: "You are an implementation worker.",
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

describe("RouteResultSchema", () => {
  it("accepts a dispatch result and isRouteDispatch narrows it", () => {
    const result = RouteResultSchema.parse({
      target: "implementation",
      workspaceId: "ws-1",
      repositoryId: "repo-1",
      reason: "request status matched",
    });
    expect(isRouteDispatch(result)).toBe(true);
    if (!isRouteDispatch(result)) throw new Error("expected a dispatch result");
    expect(result.requiredCapabilities).toEqual([]);
  });

  it("accepts a hold result and isRouteDispatch rejects it", () => {
    const result = RouteResultSchema.parse({ target: "wait", reason: "dependency not closed" });
    expect(isRouteDispatch(result)).toBe(false);
  });

  it("rejects a dispatch result missing workspaceId/repositoryId", () => {
    expect(() =>
      RouteResultSchema.parse({ target: "planning", reason: "planningStatus matched" }),
    ).toThrow();
  });

  it("rejects an unknown target value", () => {
    expect(() => RouteResultSchema.parse({ target: "bogus", reason: "x" })).toThrow();
  });
});

describe("JobEnvelopeSchema", () => {
  it("accepts a valid implementation envelope", () => {
    const envelope = JobEnvelopeSchema.parse(validEnvelope());
    expect(envelope.kind).toBe("implementation");
    expect(envelope.planningContext).toBeUndefined();
  });

  it("rejects a protocolVersion other than the current one", () => {
    expect(() => JobEnvelopeSchema.parse(validEnvelope({ protocolVersion: 999 }))).toThrow();
  });

  it("accepts a planning envelope carrying planningContext", () => {
    const envelope = JobEnvelopeSchema.parse(
      validEnvelope({
        kind: "planning",
        planningContext: { comments: [], existingSubtasks: [] },
      }),
    );
    expect(envelope.planningContext?.comments).toEqual([]);
  });

  it("rejects a non-positive timeoutMs", () => {
    expect(() => JobEnvelopeSchema.parse(validEnvelope({ timeoutMs: 0 }))).toThrow();
  });
});

describe("IssueSnapshotSchema", () => {
  it("accepts null for description/assigneeAccountId/issueTypeName/parentKey/projectKey", () => {
    expect(() => IssueSnapshotSchema.parse(validIssueSnapshot())).not.toThrow();
  });

  it("rejects a missing summary", () => {
    const { summary: _summary, ...rest } = validIssueSnapshot();
    expect(() => IssueSnapshotSchema.parse(rest)).toThrow();
  });
});

describe("JobResultSchema", () => {
  function validResult(overrides: Record<string, unknown> = {}) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      jobId: "job-1",
      attemptId: "attempt-1",
      resultId: "result-1",
      status: "succeeded",
      summary: "Implemented the thing.",
      ...overrides,
    };
  }

  it("accepts a minimal implementation result", () => {
    expect(() => JobResultSchema.parse(validResult())).not.toThrow();
  });

  it("rejects an unknown status value", () => {
    expect(() => JobResultSchema.parse(validResult({ status: "bogus" }))).toThrow();
  });

  it("accepts a planning result carrying a plan", () => {
    const result = JobResultSchema.parse(
      validResult({
        status: "planned",
        plan: {
          needsDecision: false,
          summary: "Plan summary",
          tasks: [{ title: "t", description: "d" }],
        },
      }),
    );
    expect(result.plan?.tasks).toHaveLength(1);
  });
});

describe("WorkerProviderConfigSchema", () => {
  it("defaults command to 'claude' for type claude-code", () => {
    const provider = WorkerProviderConfigSchema.parse({ id: "default" });
    expect(provider.type).toBe("claude-code");
    expect(provider.command).toBe("claude");
  });

  it("defaults command to 'codex' for type codex", () => {
    const provider = WorkerProviderConfigSchema.parse({ id: "default", type: "codex" });
    expect(provider.command).toBe("codex");
  });

  it("keeps an explicit command instead of defaulting it", () => {
    const provider = WorkerProviderConfigSchema.parse({ id: "default", command: "/opt/claude" });
    expect(provider.command).toBe("/opt/claude");
  });
});

describe("worker-facing API schemas", () => {
  it("WorkerRegisterRequestSchema requires a pairingCode and workerName", () => {
    expect(() =>
      WorkerRegisterRequestSchema.parse({ protocolVersion: PROTOCOL_VERSION, pairingCode: "abc" }),
    ).toThrow();
    expect(() =>
      WorkerRegisterRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        pairingCode: "abc",
        workerName: "worker-a",
      }),
    ).not.toThrow();
  });

  it("JobsNextRequestSchema requires a requestId for idempotent replays", () => {
    expect(() => JobsNextRequestSchema.parse({ sessionId: "s1", workerId: "worker-a" })).toThrow();
  });

  it("JobResultRequestSchema is exactly JobResultSchema", () => {
    expect(() =>
      JobResultRequestSchema.parse({
        protocolVersion: PROTOCOL_VERSION,
        jobId: "job-1",
        attemptId: "attempt-1",
        resultId: "result-1",
        status: "succeeded",
        summary: "done",
      }),
    ).not.toThrow();
  });
});
