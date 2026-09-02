export interface WorkerTaskInput {
  title: string;
  description: string | null;
}

export function buildWorkerPrompt(input: WorkerTaskInput): string {
  const parts = [`Task: ${input.title}`];
  if (input.description) {
    parts.push("", "Description:", input.description);
  }
  return parts.join("\n");
}

/** Appended as --append-system-prompt so the worker knows GGJIRA owns commits. */
export function buildTaskSystemPrompt(): string {
  return [
    "You are running as an unattended GGJIRA worker inside a dedicated git worktree.",
    "Make only the requested code changes.",
    "Do not run 'git commit', 'git push', or create pull requests — GGJIRA commits your changes after you finish.",
    "When the task is done, stop; do not wait for further input.",
  ].join(" ");
}
