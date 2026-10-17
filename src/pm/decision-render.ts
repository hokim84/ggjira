import type { DecisionRequest } from "../contracts/decision.js";
import type {
  ImplementationReport,
  LocalEvidence,
  ScopeCheck,
} from "../contracts/implementation.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";
import type { Plan } from "./plan.js";

// Kept apart from plan-render.ts so the v5 worker (which builds prompts via prompt.ts) never
// pulls in the legacy profile/ description helpers plan-render.ts depends on.
/**
 * The decision-request comment for a `needsDecision` plan. `findHumanDecision`
 * (src/pm/context.ts) reads the `planVersion:`/`decisionId:` lines back, so their format is part
 * of the contract. `replyStatus` is where the human moves the issue after answering; `signature`
 * identifies who asked (a v4 agent tag, or Router).
 */
export function renderDecisionRequest(
  plan: Plan,
  options: { planVersion?: string; replyStatus: string; signature: string },
): string {
  const decision = plan.decision;
  if (!decision) {
    throw new Error("renderDecisionRequest called on a plan with no decision");
  }
  const { planVersion } = options;

  const lines = [
    DECISION_REQUEST_MARKER,
    ...(planVersion ? [`planVersion: ${planVersion}`, `decisionId: ${planVersion}-decision`] : []),
    "",
    "GGJIRA needs a decision before it can continue planning.",
    "",
    ...decisionLines(decision),
  ];
  if (decision.impact) lines.push("", `Impact: ${decision.impact}`);
  lines.push(
    "",
    `To respond: comment "Decision: <option id>" on this issue and move it back to "${options.replyStatus}".`,
    "",
    options.signature,
  );
  return lines.join("\n");
}

/** Question, options with pros/cons, and the recommendation — shared by both decision comments. */
function decisionLines(decision: DecisionRequest): string[] {
  const lines = [`Question: ${decision.question}`, "", "Options:"];
  for (const option of decision.options) {
    lines.push(`- ${option.id}: ${option.title}`);
    if (option.pros.length > 0) lines.push(`  pros: ${option.pros.join("; ")}`);
    if (option.cons.length > 0) lines.push(`  cons: ${option.cons.join("; ")}`);
  }
  if (decision.recommendation) lines.push("", `Recommendation: ${decision.recommendation}`);
  return lines;
}

/**
 * The comment for an implementation run GGJIRA stopped before commit/push (ADR 0036): what
 * changed (why it stopped) → the options → impact → what the human has to do → where the evidence
 * is. Logs are not copied in; the evidence is referenced by location. Deliberately without
 * `DECISION_REQUEST_MARKER`: that marker belongs to the planning flow, whose reply is a
 * "Decision:" comment. Here the answer has to go into the description's contract, since only the
 * description is part of the approved input (ADR 0035).
 */
export function renderImplementationDecisionRequest(
  result: {
    summary: string;
    implementation?: ImplementationReport | undefined;
    scopeCheck?: ScopeCheck | undefined;
    localEvidence?: LocalEvidence | undefined;
  },
  options: { requestStatus: string; signature: string },
): string {
  const report = result.implementation;
  const outside = result.scopeCheck?.outsideAllowed ?? [];
  const lines = [
    "GGJIRA stopped this implementation before commit and push: it needs a human decision.",
  ];

  lines.push("", "What happened:", report?.summary ?? result.summary);
  for (const deviation of report?.scopeDeviations ?? []) {
    lines.push(`- Out of scope: ${deviation.description} (${deviation.reason})`);
  }
  if (outside.length > 0) {
    lines.push("- Changed paths outside Allowed Paths:");
    for (const change of outside) {
      lines.push(`  - ${change.from ? `${change.from} -> ` : ""}${change.path} (${change.change})`);
    }
  }

  if (report?.decision) lines.push("", ...decisionLines(report.decision));
  const impact = report?.decision?.impact;
  lines.push(
    "",
    `Impact: ${impact ?? "nothing was committed, pushed or opened as a pull request; the issue waits for a decision."}`,
  );

  lines.push(
    "",
    `To continue: record the decision in the issue description — adjust In Scope, Out of Scope, Allowed Paths or Acceptance Criteria — then move the issue to "${options.requestStatus}" again. A comment alone is not enough: comments are not part of the approved request, and the edited request runs as a new attempt under the new approval.`,
  );

  const evidence = result.localEvidence;
  if (evidence) {
    lines.push("", "Evidence (on the worker):");
    if (evidence.branch) lines.push(`- branch: ${evidence.branch} (not pushed)`);
    if (evidence.worktreePath) lines.push(`- worktree: ${evidence.worktreePath}`);
    if (evidence.patchFile) lines.push(`- patch: ${evidence.patchFile}`);
    lines.push(`- cleanup: ${evidence.cleanup}`);
  }
  lines.push("", options.signature);
  return lines.join("\n");
}
