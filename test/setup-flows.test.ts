import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JiraApiError } from "../src/jira/client.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import type { JiraUser } from "../src/jira/types.js";
import { claimAgentProfile, createAgentProfile } from "../src/profile/profile.js";
import { AGENT_LABEL, REGISTRATION_PROPERTY, WORKSPACE_LABEL } from "../src/profile/types.js";
import { runSetupWizard } from "../src/setup/wizard.js";

function scriptedAsk(
  answers: string[],
): (question: string, defaultValue?: string) => Promise<string> {
  let i = 0;
  return async (question, defaultValue) => {
    const answer = answers[i++];
    if (answer === undefined) throw new Error("scriptedAsk ran out of answers");
    return answer === "" ? (defaultValue ?? "") : answer;
  };
}

const FIXED_MACHINE_ID = "1d88f0a2-1111-4111-8111-111111111111";

describe("runSetupWizard: Create GGJira Workspace", () => {
  let cwd: string;
  let jira: FakeJiraGateway;
  let lines: string[];

  beforeEach(() => {
    cwd = mkdtempSync(path.join(tmpdir(), "ggjira-setup-create-test-"));
    jira = new FakeJiraGateway();
    jira.seedProject({
      key: "KAN",
      name: "Kanban",
      issueTypes: [
        { name: "Task", subtask: false },
        { name: "Subtask", subtask: true },
      ],
    });
    lines = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("creates a workspace from three picked statuses and writes them to the v4 config", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중", "완료", "AI 작업 요청"]);
    const ask = scriptedAsk([
      "https://example.atlassian.net", // Jira URL
      "a@b.com", // email
      "secret-token", // api token
      "", // project key (default: the single seeded project)
      "5", // AI request status -> "AI 작업 요청"
      "2", // in-progress status -> "진행 중"
      "3", // review status -> "검토 중"
      "", // issue type
      "", // agent id (pm-01)
      "", // create implement profile? (n)
      cwd, // workspace path
      "", // base branch
      "", // provider
      "", // model
      "", // start the agent now? (y)
    ]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(true);

    const workspaceIssue = jira.createdIssues.find((i) => i.labels?.includes(WORKSPACE_LABEL));
    expect(workspaceIssue).toBeDefined();
    const profileIssue = jira.createdIssues.find((i) => i.labels?.includes(AGENT_LABEL));
    expect(profileIssue?.summary).toBe("[AGENT] pm-01");

    const configPath = path.join(cwd, "ggjira.config.json");
    const envPath = path.join(cwd, ".env");
    expect(existsSync(configPath)).toBe(true);
    if (process.platform !== "win32") expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.configVersion).toBe(4);
    expect(config.agent.machineId).toBe(FIXED_MACHINE_ID);
    expect(config.workflow).toEqual({
      implementationStatus: "AI 작업 요청",
      inProgressStatus: "진행 중",
      reviewStatus: "검토 중",
    });
    // No transition names anywhere: the runtime resolves those from the statuses.
    expect(JSON.stringify(config.workflow)).not.toContain("Transition");
    expect(workspaceIssue?.description).toContain("AI Request Status: AI 작업 요청");
    expect(workspaceIssue?.description).toContain("Review Status: 검토 중");

    const registration = jira.getStoredProperty(config.agent.profileKey, REGISTRATION_PROPERTY) as
      | { machineId: string }
      | undefined;
    expect(registration?.machineId).toBe(FIXED_MACHINE_ID);
  });

  it("accepts a status typed by name as well as by number", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중", "AI 작업 요청"]);
    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "AI 작업 요청",
      "진행 중",
      "검토 중",
      "",
      "",
      "",
      cwd,
      "",
      "",
      "",
      "",
    ]);

    await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.workflow.implementationStatus).toBe("AI 작업 요청");
    expect(config.workflow.reviewStatus).toBe("검토 중");
  });

  it("rejects a status the project does not have", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중"]);
    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "AI Implementation", // not a status in this project
    ]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(false);
    expect(existsSync(path.join(cwd, "ggjira.config.json"))).toBe(false);
    expect(
      lines.some((l) => l.includes('"AI Implementation" is not a status in this project')),
    ).toBe(true);
    process.exitCode = 0;
  });

  it("rejects picking the same status twice", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중", "AI 작업 요청"]);
    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "4", // AI 작업 요청
      "2", // 진행 중
      "2", // 진행 중 again
    ]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(false);
    expect(lines.some((l) => l.includes("must be different from each other"))).toBe(true);
    process.exitCode = 0;
  });

  it("is idempotent: running Create twice creates no duplicate issues and keeps the statuses", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중", "AI 작업 요청"]);
    const firstAnswers = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "4",
      "2",
      "3",
      "",
      "",
      "",
      cwd,
      "",
      "",
      "",
      "",
    ]);
    await runSetupWizard({
      check: false,
      cwd,
      ask: firstAnswers,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });
    expect(jira.createdIssues).toHaveLength(2); // workspace + PM profile

    // Second run: the workspace already exists, so setup only offers to change
    // the statuses ("" -> its default "n") and every other default is prefilled.
    const secondAnswers = scriptedAsk(Array(12).fill(""));
    const result = await runSetupWizard({
      check: false,
      cwd,
      ask: secondAnswers,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(true);
    expect(jira.createdIssues).toHaveLength(2); // no new issues created
    expect(jira.comments).toHaveLength(1); // no duplicate "registered" comment
    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.workflow.reviewStatus).toBe("검토 중");
  });

  it("changes an existing workspace's statuses when the admin opts in", async () => {
    jira.seedProjectStatuses("KAN", ["해야 할 일", "진행 중", "검토 중", "AI 작업 요청"]);
    const firstAnswers = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "4", // AI 작업 요청
      "2", // 진행 중
      "1", // 해야 할 일 (wrong on purpose -- this is what gets corrected below)
      "",
      "",
      "",
      cwd,
      "",
      "",
      "",
      "",
    ]);
    await runSetupWizard({
      check: false,
      cwd,
      ask: firstAnswers,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });
    const workspaceKey = (await jira.searchIssues(`labels = "${WORKSPACE_LABEL}"`))[0]?.key;
    expect(workspaceKey).toBeDefined();

    const secondAnswers = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "", // project key
      "y", // change these statuses?
      "", // AI request status (keep: AI 작업 요청)
      "", // in-progress status (keep: 진행 중)
      "3", // review status -> 검토 중
      "", // agent id
      "", // create implement profile?
      cwd, // workspace path
      "",
      "",
      "",
      "",
    ]);
    const result = await runSetupWizard({
      check: false,
      cwd,
      ask: secondAnswers,
      mode: "create",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(true);
    expect(jira.createdIssues).toHaveLength(2); // still no duplicates
    const updated = await jira.getIssue(workspaceKey as string);
    expect(updated.description).toContain("Review Status: 검토 중");
    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.workflow.reviewStatus).toBe("검토 중");
  });

  it("fails cleanly with a human-readable message when Jira credentials are invalid", async () => {
    class UnauthorizedGateway extends FakeJiraGateway {
      override async getMyself(): Promise<JiraUser> {
        throw new JiraApiError("unauthorized", 401, "/rest/api/2/myself");
      }
    }
    const unauthorizedJira = new UnauthorizedGateway();
    const ask = scriptedAsk(["https://example.atlassian.net", "a@b.com", "bad-token"]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "create",
      createJira: () => unauthorizedJira,
      settleMs: 0,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(false);
    expect(existsSync(path.join(cwd, "ggjira.config.json"))).toBe(false);
    expect(
      lines.some((l) =>
        l.includes("Setup failed: Could not connect to Jira: Invalid email or API token."),
      ),
    ).toBe(true);
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });
});

describe("runSetupWizard: Join as Agent", () => {
  let cwd: string;
  let jira: FakeJiraGateway;
  let lines: string[];

  beforeEach(async () => {
    cwd = mkdtempSync(path.join(tmpdir(), "ggjira-setup-join-test-"));
    jira = new FakeJiraGateway();
    jira.seedProject({
      key: "KAN",
      name: "Kanban",
      issueTypes: [{ name: "Task", subtask: false }],
    });
    lines = [];
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  async function seedWorkspace(): Promise<void> {
    await jira.createIssue({
      projectKey: "KAN",
      issueTypeName: "Task",
      summary: "[GGJIRA] Workspace Configuration",
      labels: [WORKSPACE_LABEL],
      description: [
        "h2. GGJira Workspace",
        "Config Version: 3",
        "GGJira Version: 0.1.0",
        "Project Key: KAN",
        "",
        "h2. Workflow",
        "AI Request Status: AI 작업 요청",
        "In Progress Status: 진행 중",
        "Review Status: 검토 중",
        "Subtask Issue Type: Subtask",
      ].join("\n"),
    });
  }

  it("lists only enabled agents, registers the selected one, and copies Workflow from the workspace issue", async () => {
    await seedWorkspace();
    const enabledProfile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: "unity-programmer",
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    const disabledProfile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "disabled-agent",
      displayName: "Disabled Agent",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    await jira.addLabel(disabledProfile.issueKey, "ggjira-disabled");

    const ask = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "", // project key
      "unity-implement-01", // select agent
      cwd, // workspace path
      "", // base branch
      "", // provider
      "", // model
      "", // start agent
    ]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "join",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(true);
    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.agent.identity).toBe("unity-implement-01");
    expect(config.agent.role).toBe("implement");
    expect(config.agent.profileKey).toBe(enabledProfile.issueKey);
    expect(config.workflow.implementationStatus).toBe("AI 작업 요청");
    expect(config.workflow.inProgressStatus).toBe("진행 중");
    expect(config.workflow.reviewStatus).toBe("검토 중");
    expect(config.pm.implementAssignee).toBeUndefined();
  });

  it("throws a clear error when no workspace configuration exists yet", async () => {
    const ask = scriptedAsk(["https://example.atlassian.net", "a@b.com", "secret-token", ""]);

    const result = await runSetupWizard({
      check: false,
      cwd,
      ask,
      mode: "join",
      createJira: () => jira,
      settleMs: 0,
      print: (l) => lines.push(l),
    });

    expect(result.startAgent).toBe(false);
    expect(lines.some((l) => l.includes("No GGJira workspace found"))).toBe(true);
    process.exitCode = 0;
  });

  it("refuses to join a profile registered to a different machine unless takeover is confirmed", async () => {
    await seedWorkspace();
    const profile = await createAgentProfile(jira, {
      projectKey: "KAN",
      issueTypeName: "Task",
      agentId: "unity-implement-01",
      displayName: "Unity Implement 01",
      role: "implement",
      preset: null,
      capabilities: [],
      workStyle: [],
      humanInstructions: [],
    });
    await claimAgentProfile(jira, profile, "some-other-machine-id", { settleMs: 0 });

    const declineAsk = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "unity-implement-01",
      "n", // decline takeover
    ]);
    const declineResult = await runSetupWizard({
      check: false,
      cwd,
      ask: declineAsk,
      mode: "join",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });
    expect(declineResult.startAgent).toBe(false);
    expect(existsSync(path.join(cwd, "ggjira.config.json"))).toBe(false);
    process.exitCode = 0;

    const acceptAsk = scriptedAsk([
      "https://example.atlassian.net",
      "a@b.com",
      "secret-token",
      "",
      "unity-implement-01",
      "y", // accept takeover
      cwd,
      "",
      "",
      "",
      "",
    ]);
    const acceptResult = await runSetupWizard({
      check: false,
      cwd,
      ask: acceptAsk,
      mode: "join",
      createJira: () => jira,
      settleMs: 0,
      machineIdFactory: () => FIXED_MACHINE_ID,
      print: (l) => lines.push(l),
    });
    expect(acceptResult.startAgent).toBe(true);
    const config = JSON.parse(readFileSync(path.join(cwd, "ggjira.config.json"), "utf-8"));
    expect(config.agent.machineId).toBe(FIXED_MACHINE_ID);
  });
});
