export interface ImplementTaskInput {
  title: string;
  description: string | null;
  /** The approved scope contract (ADR 0034/0036). Structural, so this module needs no contracts. */
  contract?: {
    acceptance: readonly string[];
    verification: readonly string[];
    inScope: readonly string[];
    outOfScope: readonly string[];
    affectedAreas: readonly string[];
    allowedPaths: readonly string[];
    constraints: readonly string[];
  };
}

function listSection(heading: string, items: readonly string[]): string[] {
  return items.length > 0 ? ["", `${heading}:`, ...items.map((item) => `- ${item}`)] : [];
}

export function buildImplementPrompt(input: ImplementTaskInput): string {
  const parts = [`Task: ${input.title}`];
  if (input.description) {
    parts.push("", "Description:", input.description);
  }
  const contract = input.contract;
  if (contract) {
    parts.push(
      "",
      "Approved scope contract (the request above was approved with exactly this scope):",
      ...listSection("Acceptance criteria", contract.acceptance),
      ...listSection("Verification (how to check each criterion)", contract.verification),
      ...listSection("In scope", contract.inScope),
      ...listSection("Out of scope", contract.outOfScope),
      ...listSection("Expected areas (a hint, not a limit)", contract.affectedAreas),
      ...listSection(
        "Allowed paths (repository-relative globs; touching anything else stops the job)",
        contract.allowedPaths,
      ),
      ...listSection("Constraints", contract.constraints),
    );
  }
  return parts.join("\n");
}

/** Appended as the worker's systemPrompt so it knows GGJIRA owns Git operations when available,
 *  and what to do when the approved scope is not enough (ADR 0036). */
export function buildImplementSystemPrompt(): string {
  return [
    "You are running as an unattended GGJIRA implement agent in the configured workspace.",
    "Make only the requested code changes, within the approved scope contract.",
    "Do not run 'git commit', 'git push', or create pull requests; GGJIRA handles Git operations when the workspace is a repository.",
    "If finishing the task would need a change the contract does not cover — a public API, data model or design change listed as out of scope or not mentioned, or files outside the allowed paths — stop making changes and hand the decision back: set outcome to needs_decision and give the reason, the options with their pros and cons, the impact and your recommendation in decision, and list each deviation in scopeDeviations.",
    "Otherwise set outcome to completed. For every acceptance criterion, run or perform its verification and report pass, fail or not_verified with the evidence (the command and what it showed). Never report pass without having checked.",
    "Your final answer is one JSON object matching the given schema and nothing else. Then stop; do not wait for further input.",
  ].join(" ");
}
