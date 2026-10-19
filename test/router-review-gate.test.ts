import { describe, expect, it } from "vitest";
import type { JobResult } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import type { WorkspaceConfig } from "../src/router/config.js";
import { assessResult, reviewPolicyVersion } from "../src/router/review-gate.js";
import { testWorkspace } from "./helpers/router-fixtures.js";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const workspace: WorkspaceConfig = {
  ...testWorkspace,
  review: {
    highRiskPaths: [
      { name: "migrations", paths: ["db/migrations/**"] },
      { name: "public api", paths: ["src/contracts/**", "openapi.yaml"] },
    ],
  },
};

function result(overrides: Partial<JobResult> = {}): JobResult {
  return {
    protocolVersion: PROTOCOL_VERSION,
    jobId: "job-1",
    attemptId: "attempt-1",
    resultId: "result-1",
    status: "succeeded",
    summary: "done",
    implementation: {
      outcome: "completed",
      summary: "done",
      scopeDeviations: [],
      risks: [],
      verification: [{ acceptance: "It works", status: "pass", evidence: "npm test" }],
    },
    scopeCheck: {
      checked: false,
      reason: "the contract has no allowedPaths",
      changedPaths: [{ path: "src/app.ts", change: "modified" }],
      outsideAllowed: [],
    },
    git: { repository: "git", baseBranch: "main", baseSha: BASE, headSha: HEAD, committed: true },
    ...overrides,
  };
}

function assess(r: JobResult, ws: WorkspaceConfig = workspace) {
  return assessResult({
    kind: "implementation",
    finalState: "succeeded",
    result: r,
    workspace: ws,
  });
}

/** M4-11 (ADR 0040): what a human has to look at in one result. */
describe("assessResult", () => {
  it("puts a verified, committed change that matches no rule in the ordinary queue", () => {
    const review = assess(result());
    expect(review).toMatchObject({
      reviewClass: "standard",
      reasons: [],
      commit: { state: "committed", baseSha: BASE, headSha: HEAD },
      verification: { reported: true, pass: 1, fail: 0, notVerified: 0 },
      risk: { status: "not_matched", policyVersion: reviewPolicyVersion(workspace), matches: [] },
    });
    // Not matching a rule is never called low risk.
    expect(review.risk.basis).toContain("does not make it low risk");
  });

  it("flags added, deleted and renamed paths in high-risk areas, at either end of a rename (T18)", () => {
    const review = assess(
      result({
        scopeCheck: {
          checked: true,
          changedPaths: [
            { path: "db/migrations/0012_add.sql", change: "added" },
            { path: "openapi.yaml", change: "deleted" },
            { path: "src/types.ts", change: "renamed", from: "src/contracts/types.ts" },
            { path: "src/app.ts", change: "modified" },
          ],
          outsideAllowed: [],
        },
      }),
    );
    expect(review.reviewClass).toBe("immediate");
    expect(review.reasons.map((reason) => reason.code)).toEqual(["high_risk"]);
    expect(review.risk.matches).toEqual([
      { rule: "migrations", path: "db/migrations/0012_add.sql", change: "added" },
      { rule: "public api", path: "openapi.yaml", change: "deleted" },
      {
        rule: "public api",
        path: "src/types.ts",
        change: "renamed",
        from: "src/contracts/types.ts",
      },
    ]);
    expect(review.risk.policyVersion).toMatch(/^[0-9a-f]{12}$/);
  });

  it("keeps the agent's own risk report as evidence and reviews it individually", () => {
    const base = result();
    const review = assess(
      result({
        implementation: {
          ...(base.implementation as NonNullable<JobResult["implementation"]>),
          risks: [{ area: "permissions", description: "admins can now delete workers" }],
        },
      }),
    );
    expect(review.reviewClass).toBe("immediate");
    expect(review.risk).toMatchObject({
      status: "high",
      agentRisks: [{ area: "permissions", description: "admins can now delete workers" }],
    });
  });

  it("says unknown — not low — without rules or without changed paths", () => {
    expect(assess(result(), testWorkspace).risk).toMatchObject({
      status: "unknown",
      policyVersion: null,
      basis: "the workspace has no review.highRiskPaths",
    });
    const { scopeCheck: _ignored, git: _alsoIgnored, ...old } = result();
    const review = assess(old as JobResult);
    expect(review.risk).toMatchObject({ status: "unknown" });
    expect(review.risk.basis).toContain("did not report");
    expect(review.reasons.map((reason) => reason.code)).toEqual(["commit_unknown"]);
  });

  it("asks for individual judgement of a result with no commit (T19)", () => {
    const review = assess(
      result({
        git: { repository: "none", committed: false },
        artifacts: ["workspace: /srv/app (direct edits; no Git branch or commit)"],
      }),
    );
    expect(review.commit).toEqual({
      state: "no_commit",
      location: "workspace: /srv/app (direct edits; no Git branch or commit)",
    });
    expect(review.commit.headSha).toBeUndefined();
    expect(review.reviewClass).toBe("immediate");
    expect(review.reasons.map((reason) => reason.code)).toEqual(["no_commit"]);
    expect(review.risk.status).toBe("unknown");
  });

  it("does not pass an acceptance criterion that was not verified as an ordinary success", () => {
    const base = result();
    const review = assess(
      result({
        implementation: {
          ...(base.implementation as NonNullable<JobResult["implementation"]>),
          verification: [
            { acceptance: "It works", status: "pass", evidence: "npm test" },
            { acceptance: "It is fast", status: "not_verified", evidence: "no benchmark" },
          ],
        },
      }),
    );
    expect(review.reviewClass).toBe("immediate");
    expect(review.verification).toMatchObject({ pass: 1, notVerified: 1 });
    expect(review.reasons.map((reason) => reason.code)).toEqual(["not_verified"]);
  });

  it("classifies decisions, scope deviations and failures as needing attention", () => {
    expect(
      assess(
        result({
          status: "needs_decision",
          scopeCheck: {
            checked: true,
            changedPaths: [],
            outsideAllowed: [{ path: "x", change: "added" }],
          },
        }),
      ).reasons[0]?.code,
    ).toBe("scope_deviation");
    expect(
      assessResult({
        kind: "planning",
        finalState: "succeeded",
        result: result({ status: "needs_decision" }),
        workspace,
      }).reasons[0]?.code,
    ).toBe("decision_needed");
    expect(
      assessResult({ kind: "implementation", finalState: "timed_out", result: result(), workspace })
        .reasons[0],
    ).toEqual({ code: "failed", detail: "the run timed out" });
    expect(
      assessResult({
        kind: "planning",
        finalState: "succeeded",
        result: result({ status: "planned" }),
        workspace,
      }),
    ).toMatchObject({ reviewClass: "standard", commit: { state: "not_applicable" } });
  });

  it("versions the rules by content, not by their order", () => {
    const reordered: WorkspaceConfig = {
      ...workspace,
      review: {
        highRiskPaths: [
          { name: "public api", paths: ["openapi.yaml", "src/contracts/**"] },
          { name: "migrations", paths: ["db/migrations/**"] },
        ],
      },
    };
    expect(reviewPolicyVersion(reordered)).toBe(reviewPolicyVersion(workspace));
    expect(reviewPolicyVersion(testWorkspace)).toBeNull();
  });
});
