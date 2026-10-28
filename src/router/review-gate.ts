import { createHash } from "node:crypto";
import type { JobKind } from "../contracts/protocol.js";
import type { JobResult } from "../contracts/envelope.js";
import type { ChangedPath } from "../contracts/implementation.js";
import { matchesAnyGlob } from "../issue/paths.js";
import type { WorkspaceConfig } from "./config.js";

/**
 * The minimal responsibility gate (M4-11, ADR 0040): what a human has to look at in one result,
 * and why. Pure — no Jira, no DB, no model call. Nothing here approves or completes anything; it
 * only says whether a result may wait in the ordinary review queue (`standard`) or needs a human's
 * individual attention first (`immediate`), with the evidence for that call.
 */

export type ReviewClass = "immediate" | "standard";

export type ReviewReasonCode =
  | "decision_needed"
  | "scope_deviation"
  | "failed"
  | "high_risk"
  | "not_verified"
  | "no_commit"
  | "commit_unknown"
  | "no_trusted_validation";

export interface ReviewReason {
  code: ReviewReasonCode;
  detail: string;
}

export interface RiskMatch {
  rule: string;
  path: string;
  change: ChangedPath["change"];
  from?: string;
}

export interface RiskEvidence {
  /** `unknown` is never read as low risk: there were no rules, or no changed paths to match. */
  status: "high" | "not_matched" | "unknown" | "not_applicable";
  /** Hash of the workspace's `review.highRiskPaths` at the time; `null` with no rules. */
  policyVersion: string | null;
  matches: RiskMatch[];
  /** What the implement agent itself reported as worth reviewing (ImplementationReport.risks). */
  agentRisks: Array<{ area: string; description: string }>;
  basis: string;
}

export interface CommitEvidence {
  /** `no_commit`: nothing committed (a workspace edited in place, or no changes); `unknown`: the
   *  worker did not say (an older worker). Never a guessed head. */
  state: "committed" | "no_commit" | "unknown" | "not_applicable";
  baseBranch?: string;
  baseSha?: string;
  headSha?: string;
  /** Where the result lives when there is no commit to point at. */
  location?: string;
}

export interface VerificationTally {
  reported: boolean;
  pass: number;
  fail: number;
  notVerified: number;
  /** How the checks were made (ADR 0059); absent from assessments stored before it. */
  executed?: number;
  inspected?: number;
}

export interface ReviewAssessment {
  reviewClass: ReviewClass;
  reasons: ReviewReason[];
  commit: CommitEvidence;
  verification: VerificationTally;
  risk: RiskEvidence;
}

/** Short and stable: the same rules always give the same version, whatever their order. */
export function reviewPolicyVersion(workspace: WorkspaceConfig): string | null {
  const rules = workspace.review?.highRiskPaths ?? [];
  if (rules.length === 0) return null;
  const canonical = rules
    .map((rule) => ({ name: rule.name, paths: [...rule.paths].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 12);
}

export function matchHighRiskPaths(
  workspace: WorkspaceConfig,
  changes: readonly ChangedPath[],
): RiskMatch[] {
  const matches: RiskMatch[] = [];
  for (const rule of workspace.review?.highRiskPaths ?? []) {
    for (const change of changes) {
      const hit =
        matchesAnyGlob(change.path, rule.paths) ||
        (change.from !== undefined && matchesAnyGlob(change.from, rule.paths));
      if (hit) {
        matches.push({
          rule: rule.name,
          path: change.path,
          change: change.change,
          ...(change.from !== undefined ? { from: change.from } : {}),
        });
      }
    }
  }
  return matches;
}

function commitEvidence(kind: JobKind, result: JobResult): CommitEvidence {
  if (kind === "planning") return { state: "not_applicable" };
  const git = result.git;
  if (!git) return { state: "unknown" };
  const shas = {
    ...(git.baseBranch ? { baseBranch: git.baseBranch } : {}),
    ...(git.baseSha ? { baseSha: git.baseSha } : {}),
  };
  if (git.committed && git.headSha) return { state: "committed", ...shas, headSha: git.headSha };
  const location =
    git.repository === "none"
      ? (result.artifacts?.find((entry) => entry.startsWith("workspace:")) ??
        "the worker's workspace (edited in place)")
      : result.localEvidence?.worktreePath
        ? `worktree ${result.localEvidence.worktreePath}`
        : "nothing changed";
  return { state: "no_commit", ...shas, location };
}

function riskEvidence(
  kind: JobKind,
  workspace: WorkspaceConfig,
  result: JobResult,
  commit: CommitEvidence,
): RiskEvidence {
  const policyVersion = reviewPolicyVersion(workspace);
  if (kind === "planning") {
    return {
      status: "not_applicable",
      policyVersion,
      matches: [],
      agentRisks: [],
      basis: "a plan changes no code",
    };
  }
  const agentRisks = result.implementation?.risks ?? [];
  // Path rules need the paths the run touched; the worker lists them in its scope check, git only.
  const pathsKnown = result.scopeCheck !== undefined && result.git?.repository === "git";
  const matches = pathsKnown
    ? matchHighRiskPaths(workspace, result.scopeCheck?.changedPaths ?? [])
    : [];
  if (matches.length > 0 || agentRisks.length > 0) {
    const basis = [
      matches.length > 0 ? `${matches.length} changed path(s) match high-risk rules` : null,
      agentRisks.length > 0 ? `the agent reported ${agentRisks.length} risk(s)` : null,
    ]
      .filter(Boolean)
      .join("; ");
    return { status: "high", policyVersion, matches, agentRisks, basis };
  }
  if (!policyVersion) {
    return {
      status: "unknown",
      policyVersion,
      matches,
      agentRisks,
      basis: "the workspace has no review.highRiskPaths",
    };
  }
  if (!pathsKnown) {
    return {
      status: "unknown",
      policyVersion,
      matches,
      agentRisks,
      basis:
        commit.state === "unknown"
          ? "the worker did not report its changed paths"
          : "no git paths to match (not a git workspace)",
    };
  }
  return {
    status: "not_matched",
    policyVersion,
    matches,
    agentRisks,
    basis: "no changed path matched a high-risk rule (this alone does not make it low risk)",
  };
}

function tally(result: JobResult): VerificationTally {
  const entries = result.implementation?.verification ?? [];
  return {
    reported: entries.length > 0,
    pass: entries.filter((entry) => entry.status === "pass").length,
    fail: entries.filter((entry) => entry.status === "fail").length,
    notVerified: entries.filter((entry) => entry.status === "not_verified").length,
    executed: entries.filter((entry) => entry.method === "executed").length,
    inspected: entries.filter((entry) => entry.method === "inspected").length,
  };
}

/**
 * Judges one applied result. `finalState` is the job's closed state; `cancelled` results are not
 * reviewable and callers do not assess them.
 */
export function assessResult(input: {
  kind: JobKind;
  finalState: "succeeded" | "failed" | "timed_out";
  result: JobResult;
  workspace: WorkspaceConfig;
}): ReviewAssessment {
  const { kind, result, workspace } = input;
  const commit = commitEvidence(kind, result);
  const risk = riskEvidence(kind, workspace, result, commit);
  const verification = tally(result);
  const reasons: ReviewReason[] = [];

  if (input.finalState !== "succeeded") {
    reasons.push({
      code: "failed",
      detail: input.finalState === "timed_out" ? "the run timed out" : "the run failed",
    });
  } else if (result.status === "needs_decision") {
    const report = result.implementation;
    const deviated =
      (report?.scopeDeviations.length ?? 0) > 0 ||
      (result.scopeCheck?.outsideAllowed.length ?? 0) > 0;
    reasons.push(
      deviated
        ? { code: "scope_deviation", detail: "the run went beyond its approved scope" }
        : { code: "decision_needed", detail: "the agent asked for a human decision" },
    );
  } else if (kind === "implementation") {
    if (risk.status === "high") reasons.push({ code: "high_risk", detail: risk.basis });
    if (verification.notVerified > 0) {
      reasons.push({
        code: "not_verified",
        detail: `${verification.notVerified} acceptance criterion/criteria not verified`,
      });
    }
    if (commit.state === "no_commit") {
      reasons.push({
        code: "no_commit",
        detail: `no commit to review (${commit.location ?? "unknown location"}); judge it on its own`,
      });
    }
    if (commit.state === "unknown") {
      reasons.push({
        code: "commit_unknown",
        detail: "the worker did not report which commit this is (older worker)",
      });
    }
    // ADR 0059: the worker's validateCommand is the only check no agent reports on itself. It
    // runs whenever configured, so no output means nothing but the agent's report backs this.
    if (result.status === "succeeded" && (result.validation ?? []).length === 0) {
      reasons.push({
        code: "no_trusted_validation",
        detail: "no worker validation command ran; only the agent's own report backs this result",
      });
    }
  }
  return {
    reviewClass: reasons.length > 0 ? "immediate" : "standard",
    reasons,
    commit,
    verification,
    risk,
  };
}
