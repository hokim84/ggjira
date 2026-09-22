import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRouterConfig, RouterConfigError } from "../src/router/config.js";

describe("loadRouterConfig", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-router-config-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function writeConfig(config: unknown): string {
    const configPath = path.join(dataDir, "router.config.json");
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  }

  function validConfig(overrides: Record<string, unknown> = {}) {
    return {
      configVersion: 5,
      jira: { baseUrl: "https://example.atlassian.net" },
      repositories: [{ id: "repo-1" }],
      workspaces: [
        {
          id: "ws-1",
          repositoryId: "repo-1",
          projectKeys: ["KAN"],
          workflow: {
            requestStatus: "AI 작업 요청",
            inProgressStatus: "작업 중",
            reviewStatus: "AI 작업 완료",
          },
        },
      ],
      ...overrides,
    };
  }

  it("loads a minimal valid config and applies defaults", () => {
    const config = loadRouterConfig(writeConfig(validConfig()));
    expect(config.db.path).toBe("data/router.sqlite3");
    expect(config.http).toEqual({ host: "127.0.0.1", port: 8787 });
    expect(config.reconciliation.startupFullSyncOnBoot).toBe(true);
    expect(config.reconciliation.backgroundIntervalMs).toBe(60_000);
    expect(config.workers).toEqual([]);
  });

  it("normalizes workflow status names to NFC", () => {
    // "AI 작업 요청" written with a decomposed (NFD) Hangul syllable should read back NFC.
    const nfd = "AI 작업 요청".normalize("NFD");
    const config = loadRouterConfig(
      writeConfig(
        validConfig({
          workspaces: [
            {
              id: "ws-1",
              repositoryId: "repo-1",
              projectKeys: ["KAN"],
              workflow: { requestStatus: nfd, inProgressStatus: "작업 중", reviewStatus: "완료" },
            },
          ],
        }),
      ),
    );
    expect(config.workspaces[0]?.workflow.requestStatus).toBe("AI 작업 요청".normalize("NFC"));
  });

  it("rejects a workspace referencing an unknown repositoryId", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            workspaces: [
              {
                id: "ws-1",
                repositoryId: "does-not-exist",
                projectKeys: ["KAN"],
                workflow: {
                  requestStatus: "요청",
                  inProgressStatus: "진행",
                  reviewStatus: "검토",
                },
              },
            ],
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("rejects two workspaces claiming the same Jira project key", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            repositories: [{ id: "repo-1" }, { id: "repo-2" }],
            workspaces: [
              {
                id: "ws-1",
                repositoryId: "repo-1",
                projectKeys: ["KAN"],
                workflow: { requestStatus: "요청", inProgressStatus: "진행", reviewStatus: "검토" },
              },
              {
                id: "ws-2",
                repositoryId: "repo-2",
                projectKeys: ["KAN"],
                workflow: { requestStatus: "요청", inProgressStatus: "진행", reviewStatus: "검토" },
              },
            ],
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("rejects requestStatus === inProgressStatus (every new issue would be picked up instantly)", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            workspaces: [
              {
                id: "ws-1",
                repositoryId: "repo-1",
                projectKeys: ["KAN"],
                workflow: { requestStatus: "요청", inProgressStatus: "요청", reviewStatus: "검토" },
              },
            ],
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("rejects planningStatus === requestStatus", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            workspaces: [
              {
                id: "ws-1",
                repositoryId: "repo-1",
                projectKeys: ["KAN"],
                workflow: {
                  requestStatus: "요청",
                  inProgressStatus: "진행",
                  reviewStatus: "검토",
                  planningStatus: "요청",
                },
              },
            ],
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("rejects a worker policy referencing an unknown repositoryId", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            workers: [{ workerId: "worker-a", allowedRepositoryIds: ["does-not-exist"] }],
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("rejects executionAgent.optionWorkerMap referencing an unknown workerId", () => {
    expect(() =>
      loadRouterConfig(
        writeConfig(
          validConfig({
            workers: [{ workerId: "worker-a", allowedRepositoryIds: ["repo-1"] }],
            executionAgent: {
              fieldId: "customfield_10050",
              optionWorkerMap: { "1": "does-not-exist" },
            },
          }),
        ),
      ),
    ).toThrow(RouterConfigError);
  });

  it("accepts a bare numeric executionAgent.fieldId and normalizes it to customfield_<id>", () => {
    const config = loadRouterConfig(
      writeConfig(
        validConfig({
          workers: [{ workerId: "worker-a", allowedRepositoryIds: ["repo-1"] }],
          executionAgent: { fieldId: "10050", optionWorkerMap: { "1": "worker-a" } },
        }),
      ),
    );
    expect(config.executionAgent?.fieldId).toBe("customfield_10050");
  });

  it("throws RouterConfigError for a missing config file", () => {
    expect(() => loadRouterConfig(path.join(dataDir, "does-not-exist.json"))).toThrow(
      RouterConfigError,
    );
  });

  it("throws RouterConfigError for invalid JSON", () => {
    const configPath = path.join(dataDir, "router.config.json");
    writeFileSync(configPath, "{ not json");
    expect(() => loadRouterConfig(configPath)).toThrow(RouterConfigError);
  });

  it("rejects configVersion values other than 5", () => {
    expect(() => loadRouterConfig(writeConfig(validConfig({ configVersion: 4 })))).toThrow(
      RouterConfigError,
    );
  });
});
