import { describe, expect, it } from "vitest";
import type { IssueRequirements } from "../src/issue/requirements.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { PlanTaskMetadata } from "../src/pm/metadata.js";
import {
  computeApprovalId,
  computeDelegationApprovalIds,
  computeInputHash,
  computeLegacyInputHash,
  inputHashMatches,
} from "../src/router/approval.js";

const REQUEST_STATUS = "AI 작업 요청";

describe("computeApprovalId", () => {
  it("falls back to a per-issue sentinel when the issue was created straight into requestStatus", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: REQUEST_STATUS });

    const approvalId = await computeApprovalId(jira, await jira.getIssue("KAN-1"), REQUEST_STATUS);

    expect(approvalId).toBe("created:KAN-1");
  });

  it("uses the changelog entry that moved the issue into requestStatus", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Request", toStatusName: REQUEST_STATUS },
    ]);
    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);

    const approvalId = await computeApprovalId(jira, await jira.getIssue("KAN-1"), REQUEST_STATUS);

    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(approvalId).toBe(changelog[0]?.id);
  });

  it("uses the most recent entry into requestStatus after a revoke-then-reapprove", async () => {
    const jira = new FakeJiraGateway();
    jira.seedIssue({ key: "KAN-1", statusName: "To Do" }, [
      { id: "1", name: "Request", toStatusName: REQUEST_STATUS },
      { id: "2", name: "Revoke", toStatusName: "To Do" },
      { id: "3", name: "Request again", toStatusName: REQUEST_STATUS },
    ]);

    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    const firstApprovalId = await computeApprovalId(
      jira,
      await jira.getIssue("KAN-1"),
      REQUEST_STATUS,
    );

    await jira.transitionIssueToStatus("KAN-1", "To Do");
    await jira.transitionIssueToStatus("KAN-1", REQUEST_STATUS);
    const secondApprovalId = await computeApprovalId(
      jira,
      await jira.getIssue("KAN-1"),
      REQUEST_STATUS,
    );

    expect(secondApprovalId).not.toBe(firstApprovalId);
  });
});

describe("computeDelegationApprovalIds (ADR 0044)", () => {
  const STATUSES = {
    requestStatus: "AI 계획 요청",
    planReviewStatus: "계획 검토 대기",
    inProgressStatus: "작업 중",
  };

  function seeded(): FakeJiraGateway {
    const jira = new FakeJiraGateway();
    jira.seedIssue(
      { key: "KAN-1", statusName: "할 일" },
      ["할 일", ...Object.values(STATUSES)].map((status) => ({
        id: status,
        name: status,
        toStatusName: status,
      })),
    );
    return jira;
  }

  const idsOf = async (jira: FakeJiraGateway) =>
    computeDelegationApprovalIds(jira, await jira.getIssue("KAN-1"), STATUSES);

  it("approves nothing for an issue a person moved to in progress", async () => {
    const jira = seeded();
    await jira.transitionIssueToStatus("KAN-1", STATUSES.inProgressStatus);
    expect(await idsOf(jira)).toEqual({ requestApprovalId: "created:KAN-1", planApprovalId: null });
  });

  it("is the move from plan review to in progress after the latest request", async () => {
    const jira = seeded();
    await jira.transitionIssueToStatus("KAN-1", STATUSES.requestStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.planReviewStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.inProgressStatus);
    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(await idsOf(jira)).toEqual({
      requestApprovalId: changelog[0]?.id,
      planApprovalId: changelog[2]?.id,
    });
  });

  it("forgets an approval once the issue is requested again", async () => {
    const jira = seeded();
    await jira.transitionIssueToStatus("KAN-1", STATUSES.requestStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.planReviewStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.inProgressStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.requestStatus);
    await jira.transitionIssueToStatus("KAN-1", STATUSES.inProgressStatus);
    const changelog = await jira.getIssueChangelog("KAN-1");
    expect(await idsOf(jira)).toEqual({
      requestApprovalId: changelog[3]?.id,
      planApprovalId: null,
    });
  });
});

function requirements(overrides: Partial<IssueRequirements> = {}): IssueRequirements {
  return {
    objective: "Do the thing",
    acceptanceCriteria: ["It works"],
    dependencies: [],
    constraints: [],
    requiredCapabilities: ["programming"],
    suggestedExecutionStrategy: null,
    verification: ["npm run test"],
    inScope: [],
    outOfScope: [],
    affectedAreas: [],
    allowedPaths: [],
    ...overrides,
  };
}

const planTask: PlanTaskMetadata = {
  planVersion: "v1",
  taskId: "t1",
  parentKey: "KAN-0",
  workspaceId: "ws1",
  dependencies: [],
};

function hash(
  overrides: {
    kind?: "planning" | "implementation";
    summary?: string;
    description?: string | null;
    requirements?: Partial<IssueRequirements>;
    planTask?: PlanTaskMetadata | null;
  } = {},
): string {
  return computeInputHash({
    kind: overrides.kind ?? "implementation",
    issue: {
      summary: overrides.summary ?? "Do the thing",
      description: overrides.description === undefined ? "Body text" : overrides.description,
    },
    requirements: requirements(overrides.requirements),
    planTask: overrides.planTask === undefined ? planTask : overrides.planTask,
  });
}

describe("computeInputHash (v2, ADR 0035)", () => {
  it("is stable and marked as v2", () => {
    expect(hash()).toBe(hash());
    expect(hash().startsWith("v2:")).toBe(true);
  });

  it.each([
    ["the title", { summary: "Do another thing" }],
    ["the free-text description", { description: "Body text, now with more" }],
    ["the execution strategy", { requirements: { suggestedExecutionStrategy: "Rewrite it" } }],
    [
      "the acceptance criteria",
      { requirements: { acceptanceCriteria: ["It works", "It is fast"] } },
    ],
    ["the verification", { requirements: { verification: ["npm run e2e"] } }],
    ["the in-scope list", { requirements: { inScope: ["Read API"] } }],
    ["the out-of-scope list", { requirements: { outOfScope: ["Writes"] } }],
    ["the allowed paths", { requirements: { allowedPaths: ["src/**"] } }],
    ["the affected areas", { requirements: { affectedAreas: ["src/api"] } }],
    ["the constraints", { requirements: { constraints: ["No new deps"] } }],
    ["the capabilities", { requirements: { requiredCapabilities: ["programming", "testing"] } }],
    ["the plan version", { planTask: { ...planTask, planVersion: "v2" } }],
    ["the plan task id", { planTask: { ...planTask, taskId: "t2" } }],
    ["the job kind", { kind: "planning" as const }],
  ])("changes when %s changes", (_label, overrides) => {
    expect(hash(overrides)).not.toBe(hash());
  });

  it("ignores line endings, trailing spaces, outer blank lines and Unicode composition", () => {
    const composed = "Caf\u00e9 body\nsecond line";
    const decomposed = "\n\nCafe\u0301 body  \r\nsecond line\t\n\n";
    expect(hash({ description: decomposed })).toBe(hash({ description: composed }));
  });

  it("treats an inner wording or blank-line change as a change", () => {
    expect(hash({ description: "Body\n\ntext" })).not.toBe(hash({ description: "Body\ntext" }));
  });

  it("does not depend on dependency or capability order, but does on acceptance order", () => {
    expect(hash({ requirements: { dependencies: ["KAN-1", "KAN-2"] } })).toBe(
      hash({ requirements: { dependencies: ["KAN-2", "KAN-1"] } }),
    );
    expect(hash({ requirements: { requiredCapabilities: ["testing", "programming"] } })).toBe(
      hash({ requirements: { requiredCapabilities: ["programming", "testing"] } }),
    );
    expect(hash({ requirements: { acceptanceCriteria: ["A", "B"] } })).not.toBe(
      hash({ requirements: { acceptanceCriteria: ["B", "A"] } }),
    );
  });
});

describe("computeLegacyInputHash (v1) and inputHashMatches", () => {
  it("keeps the v1 rules: a title or free-text edit is not a change", () => {
    expect(computeLegacyInputHash(requirements(), planTask)).toBe(
      computeLegacyInputHash(requirements({ suggestedExecutionStrategy: "Other" }), planTask),
    );
    expect(computeLegacyInputHash(requirements(), planTask).startsWith("v2:")).toBe(false);
  });

  it("compares a v2 job hash with the v2 hash and a v1 job hash with the v1 hash", () => {
    const approval = {
      inputHash: hash(),
      legacyInputHash: computeLegacyInputHash(requirements(), planTask),
    };
    expect(inputHashMatches(hash(), approval)).toBe(true);
    expect(inputHashMatches(hash({ summary: "x" }), approval)).toBe(false);
    expect(inputHashMatches(approval.legacyInputHash, approval)).toBe(true);
    expect(inputHashMatches("0".repeat(64), approval)).toBe(false);
    expect(inputHashMatches(null, approval)).toBe(true);
  });

  it("never lets a v1 job match through a v2 approval that has no legacy hash", () => {
    const legacy = computeLegacyInputHash(requirements(), planTask);
    expect(inputHashMatches(legacy, { inputHash: hash() })).toBe(false);
  });
});
