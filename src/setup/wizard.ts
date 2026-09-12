import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
// The classic callback-based readline module, not `node:readline/promises`:
// the promises Interface doesn't expose `_writeToOutput` (needed to mask
// secret input, see askSecretViaInterface) on this Node version.
import { type Interface, createInterface } from "node:readline";
import path from "node:path";
import {
  type AppConfig,
  type JiraSecrets,
  ConfigError,
  isProfileMode,
  loadAppConfig,
  loadJiraSecretsFromEnv,
  resolveJiraSecrets,
} from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import { getRegistration, parseAgentProfile } from "../profile/profile.js";
import { SetupError, describeJiraError } from "./errors.js";
import {
  type AskFn,
  type FlowContext,
  type SetupResult,
  askChoice,
  defaultCreateJira,
  runCreateWorkspaceFlow,
  runJoinAgentFlow,
  runManualFlow,
} from "./flows.js";
import { checkJiraConnection, checkProviderCommand, checkWorkspacePath } from "./validators.js";

export type { AskFn, SetupResult } from "./flows.js";
export { SetupError } from "./errors.js";

export interface SetupOptions {
  check: boolean;
  cwd: string;
  ask?: AskFn;
  askSecret?: AskFn;
  print?: (line: string) => void;
  /** Skips the menu and runs one flow directly -- used by tests and non-interactive callers. */
  mode?: "create" | "join" | "manual";
  /** Defaults to a real JiraClient; tests inject a FakeJiraGateway here. */
  createJira?: (secrets: JiraSecrets) => JiraGateway;
  /** Delay claimAgentProfile waits before re-reading to detect a race; 0 in tests. Defaults to 1000ms. */
  settleMs?: number;
  machineIdFactory?: () => string;
}

const MODE_CHOICES = ["1", "2", "3"] as const;

async function askMode(ask: AskFn, print: (line: string) => void, existingConfig?: AppConfig) {
  print(
    [
      "GGJIRA Setup",
      "  1) Create GGJira Workspace   -- first PM machine for this project",
      "  2) Join as Agent             -- register this machine as an existing Agent Profile",
      "  3) Manual setup (legacy)     -- enter every value by hand, no Agent Profile",
    ].join("\n"),
  );
  const defaultChoice = existingConfig?.agent.profileKey ? "2" : "1";
  const choice = await askChoice(ask, "Choice", MODE_CHOICES, defaultChoice);
  if (choice === "2") return "join" as const;
  if (choice === "3") return "manual" as const;
  return "create" as const;
}

/**
 * Parses the `KEY=value` lines GGJIRA's own writeEnvFile produces (not a
 * general dotenv parser -- no quoting/escaping/multiline support needed for
 * that). Missing file -> empty object, so callers can treat "no existing
 * .env" the same as "no existing values to prefill from".
 */
export function loadEnvFileVars(envPath: string): NodeJS.ProcessEnv {
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
  createJira: (secrets: JiraSecrets) => JiraGateway,
): Promise<void> {
  let config: AppConfig;
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
    envSecrets = loadJiraSecretsFromEnv({ ...process.env, ...loadEnvFileVars(envPath) });
  } catch (error) {
    print(`env: FAILED (${error instanceof Error ? error.message : String(error)})`);
    process.exitCode = 1;
    return;
  }
  print(`env: OK (${envPath})`);

  const secrets = resolveJiraSecrets(config, envSecrets);
  const jira = createJira(secrets);
  const connection = await checkJiraConnection(jira);
  print(`jira connection: ${connection.ok ? "OK" : "FAILED"} (${connection.message})`);
  if (!connection.ok) process.exitCode = 1;

  if (connection.ok && config.configVersion === 4 && config.jira.projectKey) {
    try {
      const statuses = await jira.listProjectStatuses(config.jira.projectKey);
      const trigger = config.workflow.implementationStatus ?? "AI Implementation";
      const found = statuses.includes(trigger);
      print(`implementation trigger status: ${found ? "OK" : "FAILED"} (${trigger})`);
      if (!found) process.exitCode = 1;
    } catch (error) {
      print(`implementation trigger status: could not verify (${describeJiraError(error)})`);
    }
  }

  const workspaceCheck = checkWorkspacePath(config.workspace.path);
  print(`workspace path: ${workspaceCheck.ok ? "OK" : "FAILED"} (${workspaceCheck.message})`);
  if (!workspaceCheck.ok) process.exitCode = 1;

  const providerCheck = await checkProviderCommand(config.provider.command);
  print(
    `provider "${config.provider.command}": ${providerCheck.ok ? "OK" : "FAILED"} (${providerCheck.message})`,
  );
  if (!providerCheck.ok) process.exitCode = 1;

  if (!isProfileMode(config)) return;
  try {
    const registration = await getRegistration(jira, config.agent.profileKey);
    const issue = await jira.getIssue(config.agent.profileKey);
    const profile = parseAgentProfile(issue, registration);
    if (!profile.registration) {
      print(`profile: FAILED (${config.agent.profileKey} "${profile.agentId}" is not registered)`);
      process.exitCode = 1;
    } else if (profile.registration.machineId !== config.agent.machineId) {
      print(
        `profile: FAILED (${config.agent.profileKey} "${profile.agentId}" is registered to a different machine)`,
      );
      process.exitCode = 1;
    } else if (!profile.enabled) {
      print(`profile: disabled (${config.agent.profileKey} "${profile.agentId}")`);
    } else {
      print(
        `profile: OK (${config.agent.profileKey} "${profile.agentId}", registered to this machine)`,
      );
    }
  } catch (error) {
    print(`profile: FAILED (${describeJiraError(error)})`);
    process.exitCode = 1;
  }
}

/**
 * Interactive setup. With no config yet, shows a menu (Create GGJira
 * Workspace / Join as Agent / Manual setup); an existing config re-selects
 * its previous mode by default. `--check` validates an existing setup
 * instead of prompting. See src/setup/flows.ts for what each mode actually
 * does.
 */
export async function runSetupWizard(opts: SetupOptions): Promise<SetupResult> {
  const print = opts.print ?? ((line: string) => process.stdout.write(`${line}\n`));
  const configPath = path.join(opts.cwd, "ggjira.config.json");
  const envPath = path.join(opts.cwd, ".env");
  const createJira = opts.createJira ?? defaultCreateJira;

  if (opts.check) {
    await runCheck(configPath, envPath, print, createJira);
    return { startAgent: false };
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
  let existingConfig: AppConfig | undefined;
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

  const flowCtx: FlowContext = {
    ask,
    askSecret,
    print,
    configPath,
    envPath,
    createJira,
    settleMs: opts.settleMs ?? 1000,
    machineIdFactory: opts.machineIdFactory ?? randomUUID,
    ...(existingConfig ? { existingConfig } : {}),
    ...(existingSecrets ? { existingSecrets } : {}),
  };

  try {
    print("Welcome to GGJIRA setup.\n");
    if (existingConfig) {
      print(`Found an existing setup at ${configPath} -- reusing its values as defaults.\n`);
    }

    const mode = opts.mode ?? (await askMode(ask, print, existingConfig));

    if (mode === "create") return await runCreateWorkspaceFlow(flowCtx);
    if (mode === "join") return await runJoinAgentFlow(flowCtx);
    return await runManualFlow(flowCtx);
  } catch (error) {
    if (error instanceof SetupError || error instanceof ConfigError) {
      print(`\nSetup failed: ${error.message}`);
      process.exitCode = 1;
      return { startAgent: false };
    }
    throw error;
  } finally {
    rl?.close();
  }
}
