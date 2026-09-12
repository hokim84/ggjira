import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canHandle, requiredBackends } from "../src/agent/capability.js";
import { readIssueRequirements } from "../src/agent/requirements.js";
import { JobStore } from "../src/job/store.js";
import { FakeJiraGateway } from "../src/jira/fake.js";
import { applyPlan } from "../src/pm/apply.js";
import { buildTestConfig, buildTestIssue } from "./helpers/fixtures.js";

describe("capability based architecture", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("matches canonical capabilities and derives backend requirements", () => {
    expect(canHandle(["Programming", "UI", "testing"], ["programming", "ui"])).toEqual({
      ok: true,
      missing: [],
    });
    expect(canHandle(["programming"], ["programming", "ui"]).missing).toEqual(["ui"]);
    expect(requiredBackends(["programming", "art-generation"])).toEqual([
      "filesystem",
      "git",
      "coding-runtime",
      "comfyui",
    ]);
  });

  it("reads human-editable execution requirements from a Jira description", () => {
    const issue = buildTestIssue({
      key: "KAN-1",
      description: [
        "h2. GGJIRA Plan",
        "Objective: Add drag and drop",
        "Suggested Execution Strategy: Preserve InventoryView",
        "",
        "h2. Acceptance Criteria",
        "* valid drop updates through the API",
        "",
        "h2. Required Capabilities",
        "* Programming",
        "* UI",
      ].join("\n"),
    });

    expect(readIssueRequirements(issue)).toMatchObject({
      objective: "Add drag and drop",
      acceptanceCriteria: ["valid drop updates through the API"],
      requiredCapabilities: ["programming", "ui"],
      suggestedExecutionStrategy: "Preserve InventoryView",
    });
  });

  it("v4 planning keeps the human owner on generated subtasks", async () => {
    const jira = new FakeJiraGateway();
    const parent = buildTestIssue({
      key: "KAN-1",
      projectKey: "KAN",
      assigneeAccountId: "human-account",
    });
    jira.seedIssue(parent);
    const config = buildTestConfig({ configVersion: 4 });
    const plan = {
      needsDecision: false,
      summary: "plan",
      objective: "Implement inventory drag and drop",
      acceptanceCriteria: ["drag works"],
      dependencies: [],
      constraints: [],
      requiredCapabilities: ["programming", "ui"],
      suggestedExecutionStrategy: "Use the existing view",
      tasks: [
        {
          title: "Implement drag and drop",
          description: "Add the interaction.",
          acceptance: ["drag works"],
          dependencies: [],
          constraints: ["preserve InventoryView"],
          requiredCapabilities: ["programming", "ui"],
        },
      ],
      keepTaskKeys: [],
      agentProfiles: [],
      disableAgentIds: [],
    };

    await applyPlan(jira, config, parent, plan, []);

    expect(jira.createdIssues[0]?.assigneeAccountId).toBe("human-account");
    expect(jira.createdIssues[0]?.description).toContain("h2. Required Capabilities");
    expect(jira.createdIssues[0]?.description).toContain("* ui");
  });

  it("uses an atomic filesystem lease between store instances", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-lease-test-"));
    dirs.push(dataDir);
    const first = new JobStore(dataDir);
    const second = new JobStore(dataDir);

    expect(first.claimIssue("KAN-1", "run-a")).toBe(true);
    expect(second.claimIssue("KAN-1", "run-b")).toBe(false);
    expect(second.isClaimOwnedByLiveProcess("KAN-1")).toBe(true);
    first.releaseClaim("KAN-1");
    expect(second.claimIssue("KAN-1", "run-b")).toBe(true);
  });
});
