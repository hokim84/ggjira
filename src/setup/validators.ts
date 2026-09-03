import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { JiraClient } from "../jira/client.js";
import type { JiraUser } from "../jira/types.js";

export interface CheckResult {
  ok: boolean;
  message: string;
}

export interface JiraConnectionCheck extends CheckResult {
  self?: JiraUser;
}

export async function checkJiraConnection(
  baseUrl: string,
  email: string,
  apiToken: string,
): Promise<JiraConnectionCheck> {
  try {
    const client = new JiraClient({ baseUrl, email, apiToken });
    const self = await client.getMyself();
    return { ok: true, message: `connected as ${self.displayName} (${self.accountId})`, self };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function checkWorkspacePath(workspacePath: string): CheckResult {
  if (!existsSync(workspacePath)) {
    return { ok: false, message: `path does not exist: ${workspacePath}` };
  }
  return { ok: true, message: "path exists" };
}

export async function checkIsGitRepo(workspacePath: string): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspacePath,
      stdio: "ignore",
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function checkProviderCommand(command: string): Promise<CheckResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, ["--version"], { stdio: "ignore" });
    child.on("error", (err) => resolve({ ok: false, message: err.message }));
    child.on("close", (code) =>
      resolve(
        code === 0
          ? { ok: true, message: "found" }
          : { ok: false, message: `exited with code ${code}` },
      ),
    );
  });
}
