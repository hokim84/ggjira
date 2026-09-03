import { createInterface } from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { AGENT_ROLES, type AgentRole } from "../agent/role.js";
import {
  AppConfigSchema,
  ConfigError,
  loadAppConfig,
  loadJiraSecretsFromEnv,
  resolveJiraSecrets,
} from "../config.js";
import {
  checkIsGitRepo,
  checkJiraConnection,
  checkProviderCommand,
  checkWorkspacePath,
} from "./validators.js";
import { writeConfigFile, writeEnvFile } from "./writers.js";

export type AskFn = (question: string, defaultValue?: string) => Promise<string>;

export interface SetupOptions {
  check: boolean;
  cwd: string;
  ask?: AskFn;
  askSecret?: AskFn;
  print?: (line: string) => void;
}

export class SetupError extends Error {}

async function askChoice<T extends string>(
  ask: AskFn,
  label: string,
  choices: readonly T[],
  defaultValue: T,
): Promise<T> {
  const answer = (await ask(`${label} (${choices.join("/")})`, defaultValue)).trim();
  return (choices as readonly string[]).includes(answer) ? (answer as T) : defaultValue;
}

/** Best-effort masked prompt for secrets; falls back to a plain prompt when stdin isn't a TTY. */
async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return (await rl.question(`${question}: `)).trim();
    } finally {
      rl.close();
    }
  }

  return await new Promise((resolve) => {
    process.stdout.write(`${question}: `);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.setEncoding("utf-8");
    let value = "";
    const onData = (char: string) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value.trim());
        return;
      }
      if (char === "\u0003") {
        stdin.setRawMode?.(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve("");
        return;
      }
      if (char === "\u007f") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
      process.stdout.write("*");
    };
    stdin.on("data", onData);
  });
}

async function runCheck(
  configPath: string,
  envPath: string,
  print: (line: string) => void,
): Promise<void> {
  let config: ReturnType<typeof loadAppConfig>;
  try {
    config = loadAppConfig(configPath);
  } catch (error) {
    print(`config: FAILED (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
    return;
  }
  print(`config: OK (${configPath})`);

  let envSecrets: ReturnType<typeof loadJiraSecretsFromEnv>;
  try {
    envSecrets = loadJiraSecretsFromEnv();
  } catch (error) {
    print(`env: FAILED (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
    return;
  }
  print(`env: OK (${envPath})`);

  const secrets = resolveJiraSecrets(config, envSecrets);
  const connection = await checkJiraConnection(secrets.baseUrl, secrets.email, secrets.apiToken);
  print(`jira connection: ${connection.ok ? "OK" : "FAILED"} (${connection.message})`);
  if (!connection.ok) process.exitCode = 1;

  const workspaceCheck = checkWorkspacePath(config.workspace.path);
  print(`workspace path: ${workspaceCheck.ok ? "OK" : "FAILED"} (${workspaceCheck.message})`);
  if (!workspaceCheck.ok) process.exitCode = 1;

  const providerCheck = await checkProviderCommand(config.provider.command);
  print(
    `provider "${config.provider.command}": ${providerCheck.ok ? "OK" : "FAILED"} (${providerCheck.message})`,
  );
  if (!providerCheck.ok) process.exitCode = 1;
}

/**
 * Interactive setup: Jira URL -> credentials -> connection check -> agent
 * identity/role/machine -> workspace -> provider -> workflow status/transition
 * names -> (pm only) decision transition + implement assignee -> write
 * .env + ggjira.config.json (phase 2 §5.1). `--check` validates an existing
 * setup instead of prompting.
 */
export async function runSetupWizard(opts: SetupOptions): Promise<void> {
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configPath = path.join(opts.cwd, "ggjira.config.json");
  const envPath = path.join(opts.cwd, ".env");

  if (opts.check) {
    await runCheck(configPath, envPath, print);
    return;
  }

  let rl: ReturnType<typeof createInterface> | undefined;
  const ask: AskFn =
    opts.ask ??
    (async (question, defaultValue) => {
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await rl.question(`${question}${suffix}: `)).trim();
      return answer || defaultValue || "";
    });
  const askSecret: AskFn = opts.askSecret ?? opts.ask ?? ((question) => promptSecret(question));

  try {
    print("Welcome to GGJIRA setup.\n");

    const baseUrl = await ask("Jira URL", "https://your-domain.atlassian.net");
    const email = await ask("Jira account email");
    const apiToken = await askSecret("Jira API token");

    print("Checking Jira connection...");
    const connection = await checkJiraConnection(baseUrl, email, apiToken);
    if (!connection.ok) {
      throw new SetupError(`Could not connect to Jira: ${connection.message}`);
    }
    print(`  ${connection.message}`);

    const identity = await ask(
      "Agent identity",
      connection.self?.displayName ?? "ggjira-implement",
    );
    const role = await askChoice<AgentRole>(ask, "Role", AGENT_ROLES, "implement");
    const machine = await ask("Machine name", os.hostname());

    const workspacePath = await ask("Workspace (target repo) path");
    const workspaceCheck = checkWorkspacePath(workspacePath);
    if (!workspaceCheck.ok) print(`  warning: ${workspaceCheck.message}`);
    else if (!(await checkIsGitRepo(workspacePath))) print("  warning: not a git repository");
    const baseBranch = await ask("Base branch", "main");

    const providerType = await askChoice(
      ask,
      "Provider",
      ["claude-code", "codex"] as const,
      "claude-code",
    );
    const providerCommand = providerType === "codex" ? "codex" : "claude";
    const providerCheck = await checkProviderCommand(providerCommand);
    if (!providerCheck.ok) {
      print(`  warning: could not run "${providerCommand} --version" (${providerCheck.message})`);
    }
    const model = await ask("Model", "sonnet");

    const readyStatus = await ask("Ready-to-claim Jira status", "To Do");
    const claimTransitionName = await ask("Claim transition name", "In Progress");
    const doneTransitionName = await ask("Done transition name", "In Review");

    let needsDecisionTransitionName: string | undefined;
    let implementAssignee: string | undefined;
    if (role === "pm") {
      needsDecisionTransitionName = await ask("Needs-decision transition name", "Needs Decision");
      implementAssignee = await ask(
        "Implement agent's Jira email (assignee for generated subtasks)",
      );
    }

    const raw = {
      jira: { baseUrl },
      agent: { identity, role, machine },
      workflow: {
        readyStatus,
        claimTransitionName,
        doneTransitionName,
        ...(needsDecisionTransitionName ? { needsDecisionTransitionName } : {}),
      },
      workspace: { path: workspacePath, baseBranch },
      provider: { type: providerType, command: providerCommand, model },
      pm: implementAssignee ? { implementAssignee } : {},
      polling: { intervalMs: 60000 },
    };

    const result = AppConfigSchema.safeParse(raw);
    if (!result.success) {
      throw new SetupError(`Generated config failed validation: ${result.error.message}`);
    }

    writeEnvFile(envPath, { email, apiToken });
    writeConfigFile(configPath, raw);

    print(`\nWrote ${envPath} and ${configPath}.`);
    print(
      'Run "ggjira once" to try a single poll cycle, or "ggjira setup --check" to re-validate later.',
    );
  } catch (error) {
    if (error instanceof SetupError || error instanceof ConfigError) {
      print(`\nSetup failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    rl?.close();
  }
}
