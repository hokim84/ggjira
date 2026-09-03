import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// The classic callback-based readline module, not `node:readline/promises`:
// the promises Interface doesn't expose `_writeToOutput` (needed to mask
// secret input, see askSecretViaInterface) on this Node version.
import { type Interface, createInterface } from "node:readline";
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

/**
 * Parses the `KEY=value` lines GGJIRA's own writeEnvFile produces (not a
 * general dotenv parser -- no quoting/escaping/multiline support needed for
 * that). Missing file -> empty object, so callers can treat "no existing
 * .env" the same as "no existing values to prefill from".
 */
function loadEnvFileVars(envPath: string): NodeJS.ProcessEnv {
  let content: string;
  try {
    content = readFileSync(envPath, "utf-8");
  } catch {
    return {};
  }
  const result: NodeJS.ProcessEnv = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}

/** Promisified `rl.question`, since this file uses the callback-based readline module. */
function question(rl: Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

/**
 * Ask a secret via the wizard's single shared readline interface, masking the
 * echoed input with `*` on a TTY. Deliberately reuses `rl` rather than
 * creating a second readline.Interface (or a competing raw-mode `data`
 * listener) on `process.stdin` -- a second consumer of the same stdin stream
 * previously caused a real hang: its cleanup paused stdin and never resumed
 * it, so every ask() call after the secret prompt hung forever waiting for
 * input that could no longer arrive.
 */
async function askSecretViaInterface(
  rl: Interface,
  questionText: string,
  defaultValue?: string,
): Promise<string> {
  // Never show the actual secret as a visible default (unlike ask()'s `[value]`
  // suffix) -- just note that pressing Enter keeps whatever is already saved.
  const label = defaultValue ? `${questionText} [keep existing]` : questionText;
  const rlInternal = rl as unknown as {
    _writeToOutput?: (s: string) => void;
    output: NodeJS.WritableStream;
  };
  const original = rlInternal._writeToOutput?.bind(rl);
  if (!original || !process.stdin.isTTY) {
    const answer = (await question(rl, `${label}: `)).trim();
    return answer || defaultValue || "";
  }

  let masking = false;
  rlInternal._writeToOutput = (stringToWrite: string) => {
    if (masking) {
      rlInternal.output.write("*");
    } else {
      original(stringToWrite);
    }
  };
  try {
    // rl.question() writes the prompt synchronously (via _writeToOutput,
    // still unmasked here) before this line returns; only characters typed
    // after that -- necessarily later, on their own keypress events -- can
    // land while masking is true. Writing the prompt ourselves beforehand
    // and passing an empty query does NOT work: readline's own redraw on
    // the first keystroke repositions the cursor and clears the line,
    // erasing a prompt it doesn't know it's supposed to redraw.
    const pending = question(rl, `${label}: `);
    masking = true;
    const answer = (await pending).trim();
    return answer || defaultValue || "";
  } finally {
    masking = false;
    rlInternal._writeToOutput = original;
  }
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

  // A single shared readline interface for the whole wizard: see
  // askSecretViaInterface's comment for why a second one on the same stdin
  // is not safe to create.
  let rl: Interface | undefined;
  let ask: AskFn;
  let askSecret: AskFn;
  if (opts.ask) {
    ask = opts.ask;
    askSecret = opts.askSecret ?? opts.ask;
  } else {
    const rlInstance = createInterface({ input: process.stdin, output: process.stdout });
    rl = rlInstance;
    ask = async (questionText, defaultValue) => {
      const suffix = defaultValue ? ` [${defaultValue}]` : "";
      const answer = (await question(rlInstance, `${questionText}${suffix}: `)).trim();
      return answer || defaultValue || "";
    };
    askSecret =
      opts.askSecret ??
      ((questionText, defaultValue) =>
        askSecretViaInterface(rlInstance, questionText, defaultValue));
  }

  // Best-effort: an existing config/.env (this machine's own prior setup, or
  // one copied from another machine) becomes the default for every prompt
  // below, instead of always resetting to hardcoded English defaults. This
  // is what makes "just fix workflow.readyStatus to match our board" a
  // matter of pressing Enter through everything else. A missing or v1
  // config/env is not an error here -- runCheck / loadAppConfig's own
  // ConfigError is what surfaces migration problems; here we just have
  // nothing to prefill from.
  let existingConfig: ReturnType<typeof loadAppConfig> | undefined;
  try {
    existingConfig = loadAppConfig(configPath);
  } catch {
    existingConfig = undefined;
  }
  let existingSecrets: ReturnType<typeof loadJiraSecretsFromEnv> | undefined;
  try {
    existingSecrets = loadJiraSecretsFromEnv(loadEnvFileVars(envPath));
  } catch {
    existingSecrets = undefined;
  }

  try {
    print("Welcome to GGJIRA setup.\n");
    if (existingConfig) {
      print(`Found an existing setup at ${configPath} -- reusing its values as defaults.\n`);
    }

    const baseUrl = await ask(
      "Jira URL",
      existingConfig?.jira.baseUrl ?? "https://your-domain.atlassian.net",
    );
    const email = await ask("Jira account email", existingSecrets?.email);
    const apiToken = await askSecret("Jira API token", existingSecrets?.apiToken);

    print("Checking Jira connection...");
    const connection = await checkJiraConnection(baseUrl, email, apiToken);
    if (!connection.ok) {
      throw new SetupError(`Could not connect to Jira: ${connection.message}`);
    }
    print(`  ${connection.message}`);

    const identity = await ask(
      "Agent identity",
      existingConfig?.agent.identity ?? connection.self?.displayName ?? "ggjira-implement",
    );
    const role = await askChoice<AgentRole>(
      ask,
      "Role",
      AGENT_ROLES,
      existingConfig?.agent.role ?? "implement",
    );
    const machine = await ask("Machine name", existingConfig?.agent.machine ?? os.hostname());

    const workspacePath = await ask("Workspace (target repo) path", existingConfig?.workspace.path);
    const workspaceCheck = checkWorkspacePath(workspacePath);
    if (!workspaceCheck.ok) print(`  warning: ${workspaceCheck.message}`);
    else if (!(await checkIsGitRepo(workspacePath))) print("  warning: not a git repository");
    const baseBranch = await ask("Base branch", existingConfig?.workspace.baseBranch ?? "main");

    const providerType = await askChoice(
      ask,
      "Provider",
      ["claude-code", "codex"] as const,
      existingConfig?.provider.type ?? "claude-code",
    );
    const providerCommand = providerType === "codex" ? "codex" : "claude";
    const providerCheck = await checkProviderCommand(providerCommand);
    if (!providerCheck.ok) {
      print(`  warning: could not run "${providerCommand} --version" (${providerCheck.message})`);
    }
    const model = await ask("Model", existingConfig?.provider.model ?? "sonnet");

    // Defaults match GGJIRA's own suggested Jira workflow (README "Jira 준비"):
    // create a board with these exact status/transition names, or override
    // them here to match an existing board.
    const readyStatus = await ask(
      "Ready-to-claim Jira status",
      existingConfig?.workflow.readyStatus ?? "To Do",
    );
    const claimTransitionName = await ask(
      "Claim transition name",
      existingConfig?.workflow.claimTransitionName ?? "In Progress",
    );
    const doneTransitionName = await ask(
      "Done transition name",
      existingConfig?.workflow.doneTransitionName ?? "In Review",
    );

    let needsDecisionTransitionName: string | undefined;
    let implementAssignee: string | undefined;
    if (role === "pm") {
      needsDecisionTransitionName = await ask(
        "Needs-decision transition name",
        existingConfig?.workflow.needsDecisionTransitionName ?? "Needs Decision",
      );
      implementAssignee = await ask(
        "Implement agent's Jira email (assignee for generated subtasks)",
        existingConfig?.pm.implementAssignee,
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
