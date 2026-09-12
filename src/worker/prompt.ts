export interface ImplementTaskInput {
  title: string;
  description: string | null;
}

export function buildImplementPrompt(input: ImplementTaskInput): string {
  const parts = [`Task: ${input.title}`];
  if (input.description) {
    parts.push("", "Description:", input.description);
  }
  return parts.join("\n");
}

/** Appended as the worker's systemPrompt so it knows GGJIRA owns Git operations when available. */
export function buildImplementSystemPrompt(): string {
  return [
    "You are running as an unattended GGJIRA implement agent in the configured workspace.",
    "Make only the requested code changes.",
    "Do not run 'git commit', 'git push', or create pull requests; GGJIRA handles Git operations when the workspace is a repository.",
    "When the task is done, stop; do not wait for further input.",
  ].join(" ");
}
