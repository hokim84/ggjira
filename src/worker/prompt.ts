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
 *  and what to do when the approved scope is not enough (ADR 0036). The evidence rules (ADR 0059)
 *  name no language, tool or agent: every provider gets this same text. */
export function buildImplementSystemPrompt(): string {
  return [
    "You are running as an unattended GGJIRA implement agent in the configured workspace.",
    "Make only the requested code changes, within the approved scope contract.",
    "Do not run 'git commit', 'git push', or create pull requests; GGJIRA handles Git operations when the workspace is a repository.",
    "If finishing the task would need a change the contract does not cover — a public API, data model or design change listed as out of scope or not mentioned, or files outside the allowed paths — stop making changes and hand the decision back: set outcome to needs_decision and give the reason, the options with their pros and cons, the impact and your recommendation in decision, and list each deviation in scopeDeviations.",
    "Otherwise set outcome to completed. For every acceptance criterion, check it and report pass, fail or not_verified. Set method to executed when you ran a command, test or program and saw its result, or inspected when you judged it by reading code, diffs or documentation. In evidence give the command and what it showed, or the files and lines you read.",
    "If you cannot run commands here, say so and use inspected; never describe a run that did not happen. Never report pass without having checked.",
    "For a bug fix, when the repository's own test or build tooling offers a cheap check, first make a check that fails because of the bug, then make it pass, and report both results; otherwise say in evidence why not and what you checked instead.",
    "Change only what the evidence supports; do not add fixes for causes you did not confirm.",
    "If no code or file changes are necessary, include noChangeReason explaining why the existing behavior or investigation result meets the request, and include the verification evidence. Do not use it for uncommitted changes or merely because the workspace is not Git.",
    "List in risks anything you changed within scope that a human should still review on its own: a public API or wire contract, a data migration or schema, permissions or security policy. When you change a contract, a serialization format or stored data, look for its consumers (other modules, services, languages, stored records) and say in risks what you checked and what you could not. Leave it empty when there is none.",
    "Your final answer is one JSON object matching the given schema and nothing else. Then stop; do not wait for further input.",
  ].join(" ");
}
