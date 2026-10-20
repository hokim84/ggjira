import type { DecisionRequest } from "../contracts/decision.js";
import type {
  ImplementationReport,
  LocalEvidence,
  ScopeCheck,
} from "../contracts/implementation.js";
import { DECISION_REQUEST_MARKER } from "./marker.js";
import type { Plan } from "./plan.js";

/** The labels both decision comments use; the caller (Router) supplies them in its language. */
interface DecisionLabels {
  question: string;
  options: string;
  pros: string;
  cons: string;
  recommendation: string;
  impact: string;
}

export interface DecisionText extends DecisionLabels {
  needsDecision: string;
  respond: (replyStatus: string) => string;
}

export interface ImplementationDecisionText extends DecisionLabels {
  stopped: string;
  whatHappened: string;
  outOfScope: (description: string, reason: string) => string;
  changedOutside: string;
  defaultImpact: string;
  toContinue: (requestStatus: string) => string;
  evidence: string;
  branch: (branch: string) => string;
}

// Kept apart from plan-render.ts so the v5 worker (which builds prompts via prompt.ts) never
// pulls in the legacy profile/ description helpers plan-render.ts depends on.
/**
 * The decision-request comment for a `needsDecision` plan. `findHumanDecision`
 * (src/pm/context.ts) reads the `planVersion:`/`decisionId:` lines back, so their format is part
 * of the contract. `replyStatus` is where the human moves the issue after answering; `signature`
 * identifies who asked (a v4 agent tag, or Router). `text` is every sentence besides those lines, in
 * the language Router writes.
 */
export function renderDecisionRequest(
  plan: Plan,
  options: { planVersion?: string; replyStatus: string; signature: string; text: DecisionText },
): string {
  const decision = plan.decision;
  if (!decision) {
    throw new Error("renderDecisionRequest called on a plan with no decision");
  }
  const { planVersion, text } = options;

  const lines = [
    DECISION_REQUEST_MARKER,
    ...(planVersion ? [`planVersion: ${planVersion}`, `decisionId: ${planVersion}-decision`] : []),
    "",
    text.needsDecision,
    "",
    ...decisionLines(decision, text),
  ];
  if (decision.impact) lines.push("", `${text.impact} ${decision.impact}`);
  lines.push("", text.respond(options.replyStatus), "", options.signature);
  return lines.join("\n");
}

/** Question, options with pros/cons, and the recommendation — shared by both decision comments. */
function decisionLines(decision: DecisionRequest, text: DecisionLabels): string[] {
  const lines = [`${text.question} ${decision.question}`, "", text.options];
  for (const option of decision.options) {
    lines.push(`- ${option.id}: ${option.title}`);
    if (option.pros.length > 0) lines.push(`  ${text.pros}: ${option.pros.join("; ")}`);
    if (option.cons.length > 0) lines.push(`  ${text.cons}: ${option.cons.join("; ")}`);
  }
  if (decision.recommendation) {
    lines.push("", `${text.recommendation} ${decision.recommendation}`);
  }
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
  options: { requestStatus: string; signature: string; text: ImplementationDecisionText },
): string {
  const { text } = options;
  const report = result.implementation;
  const outside = result.scopeCheck?.outsideAllowed ?? [];
  const lines = [text.stopped];

  lines.push("", text.whatHappened, report?.summary ?? result.summary);
  for (const deviation of report?.scopeDeviations ?? []) {
    lines.push(text.outOfScope(deviation.description, deviation.reason));
  }
  if (outside.length > 0) {
    lines.push(text.changedOutside);
    for (const change of outside) {
      lines.push(`  - ${change.from ? `${change.from} -> ` : ""}${change.path} (${change.change})`);
    }
  }

  if (report?.decision) lines.push("", ...decisionLines(report.decision, text));
  const impact = report?.decision?.impact;
  lines.push("", `${text.impact} ${impact ?? text.defaultImpact}`);

  lines.push("", text.toContinue(options.requestStatus));

  const evidence = result.localEvidence;
  if (evidence) {
    lines.push("", text.evidence);
    if (evidence.branch) lines.push(text.branch(evidence.branch));
    if (evidence.worktreePath) lines.push(`- worktree: ${evidence.worktreePath}`);
    if (evidence.patchFile) lines.push(`- patch: ${evidence.patchFile}`);
    lines.push(`- cleanup: ${evidence.cleanup}`);
  }
  lines.push("", options.signature);
  return lines.join("\n");
}
