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
    `Question: ${decision.question}`,
    "",
    "Options:",
  ];
  for (const option of decision.options) {
    lines.push(`- ${option.id}: ${option.title}`);
    if (option.pros.length > 0) lines.push(`  pros: ${option.pros.join("; ")}`);
    if (option.cons.length > 0) lines.push(`  cons: ${option.cons.join("; ")}`);
  }
  if (decision.recommendation) lines.push("", `Recommendation: ${decision.recommendation}`);
  if (decision.impact) lines.push("", `Impact: ${decision.impact}`);
  lines.push(
    "",
    `To respond: comment "Decision: <option id>" on this issue and move it back to "${options.replyStatus}".`,
    "",
    options.signature,
  );
  return lines.join("\n");
}
