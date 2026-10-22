import type { JiraGateway } from "../jira/gateway.js";
import { githubRepoSlug } from "../worker/worktree.js";
import type { RouterConfig, WorkspaceConfig } from "./config.js";
import type { FetchLike } from "./github.js";
import { checkWorkflowHops } from "./workflow-check.js";

/**
 * `ggjira router check`: confirms the Router config matches the real Jira before `serve`
 * (docs/router-service-implementation-plan.md §5 "운영 전환" 4. "실제 Jira 상태와 전이 가능 여부를
 * router check로 확인한다"). Read-only — it never writes to Jira.
 */

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckItem {
  level: CheckLevel;
  message: string;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredStatuses(workspace: WorkspaceConfig): Array<[label: string, status: string]> {
  const { workflow } = workspace;
  return [
    ["requestStatus", workflow.requestStatus],
    ["planningInProgressStatus", workflow.planningInProgressStatus],
    ["integrationPendingStatus", workflow.integrationPendingStatus],
    ["implementationCompleteStatus", workflow.implementationCompleteStatus],
    ["inProgressStatus", workflow.inProgressStatus],
    ["doneStatus", workflow.doneStatus],
  ];
}

async function checkProject(
  jira: JiraGateway,
  config: RouterConfig,
  workspace: WorkspaceConfig,
  projectKey: string,
  items: CheckItem[],
): Promise<void> {
  const where = `workspace "${workspace.id}" project ${projectKey}`;
  let issueTypes: Array<{ name: string; subtask: boolean }>;
  try {
    issueTypes = (await jira.getProject(projectKey)).issueTypes;
  } catch (error) {
    items.push({ level: "fail", message: `${where}: cannot read project (${errorText(error)})` });
    return;
  }

  let statuses: string[];
  try {
    statuses = (await jira.listProjectStatuses(projectKey)).map((s) => s.normalize("NFC"));
  } catch (error) {
    items.push({ level: "fail", message: `${where}: cannot list statuses (${errorText(error)})` });
    return;
  }
  for (const [label, status] of configuredStatuses(workspace)) {
    items.push(
      statuses.includes(status)
        ? { level: "ok", message: `${where}: ${label} "${status}" exists` }
        : {
            level: "fail",
            message: `${where}: ${label} "${status}" is not a status of this project (has: ${statuses.join(", ")})`,
          },
    );
  }

  try {
    for (const hop of await checkWorkflowHops(jira, projectKey, workspace.workflow)) {
      const move = `transition "${hop.from}" → "${hop.to}" (${hop.label})`;
      if (hop.state === "ok") {
        items.push({
          level: "ok",
          message: `${where}: ${move} is available${hop.sampleIssue ? ` (checked on ${hop.sampleIssue})` : ""}`,
        });
      } else if (hop.state === "missing") {
        items.push({
          level: "fail",
          message: `${where}: no ${move} in the workflow (checked on ${hop.sampleIssue}; reachable: ${hop.reachable.join(", ") || "none"})`,
        });
      } else {
        items.push({ level: "warn", message: `${where}: ${move} not verified — ${hop.reason}` });
      }
    }
  } catch (error) {
    items.push({
      level: "warn",
      message: `${where}: cannot check transitions (${errorText(error)})`,
    });
  }

  const subtaskType = config.planning.subtaskIssueType;
  const found = issueTypes.find((type) => type.name.normalize("NFC") === subtaskType);
  items.push(
    found?.subtask
      ? { level: "ok", message: `${where}: subtask issue type "${subtaskType}" exists` }
      : {
          level: "fail",
          message: `${where}: planning.subtaskIssueType "${subtaskType}" is not a subtask type of this project`,
        },
  );
  // The REST API does not expose a workflow's initial status; check it manually.
  items.push({
    level: "warn",
    message: `${where}: confirm by hand that a new "${subtaskType}" can move to "${workspace.workflow.inProgressStatus}" — Router moves the tasks of an approved plan there (ADR 0044)`,
  });
}

/** What each status's issue must be able to reach next for Router's own transitions. */
function expectedNextStatuses(workspace: WorkspaceConfig, current: string): string[] {
  const { workflow } = workspace;
  const next = new Map<string, string[]>([
    [workflow.requestStatus, [workflow.planningInProgressStatus]],
    [workflow.planningInProgressStatus, [workflow.inProgressStatus]],
    [
      workflow.inProgressStatus,
      [workflow.integrationPendingStatus, workflow.implementationCompleteStatus],
    ],
    [workflow.integrationPendingStatus, [workflow.implementationCompleteStatus]],
    [workflow.implementationCompleteStatus, [workflow.doneStatus]],
    ...(workflow.doneStatus
      ? [[workflow.implementationCompleteStatus, [workflow.doneStatus]] as [string, string[]]]
      : []),
  ]);
  return next.get(current) ?? [];
}

async function checkSampleIssue(
  jira: JiraGateway,
  config: RouterConfig,
  issueKey: string,
  items: CheckItem[],
): Promise<void> {
  let issue: Awaited<ReturnType<JiraGateway["getIssue"]>>;
  try {
    issue = await jira.getIssue(issueKey);
  } catch (error) {
    items.push({ level: "fail", message: `issue ${issueKey}: cannot read (${errorText(error)})` });
    return;
  }
  const workspace = config.workspaces.find((w) => w.projectKeys.includes(issue.projectKey ?? ""));
  if (!workspace) {
    items.push({
      level: "fail",
      message: `issue ${issueKey}: project ${issue.projectKey ?? "?"} is not in any workspace`,
    });
    return;
  }
  const transitions = await jira.getTransitions(issueKey);
  const reachable = transitions.map((t) => t.toStatusName.normalize("NFC"));
  const expected = expectedNextStatuses(workspace, issue.statusName);
  if (expected.length === 0) {
    items.push({
      level: "warn",
      message: `issue ${issueKey} is in "${issue.statusName}", which Router never moves from; pick an issue in the request or in-progress status to check transitions (reachable now: ${reachable.join(", ") || "none"})`,
    });
    return;
  }
  for (const status of expected) {
    items.push(
      reachable.includes(status)
        ? {
            level: "ok",
            message: `issue ${issueKey}: "${issue.statusName}" → "${status}" is available`,
          }
        : {
            level: "fail",
            message: `issue ${issueKey}: no transition from "${issue.statusName}" to "${status}" (reachable: ${reachable.join(", ") || "none"})`,
          },
    );
  }
}

/**
 * The GitHub repositories Router follows pull requests in: those the config clones from GitHub,
 * and those workers already opened pull requests in (Router learns a repository from the first).
 */
export function githubRepositoriesToCheck(
  config: RouterConfig,
  pullRequestRepos: readonly string[],
): string[] {
  const slugs = config.repositories
    .map((repository) => (repository.cloneUrl ? githubRepoSlug(repository.cloneUrl) : undefined))
    .filter((slug): slug is string => Boolean(slug));
  return [...new Set([...slugs, ...pullRequestRepos].map((slug) => slug.toLowerCase()))].sort();
}

/**
 * Whether Router can read each repository's pull requests the way the poll does (ADR 0027, 0032):
 * GitHub answers 404 for a private repository it won't show, so a merge would go unnoticed.
 */
export async function checkGithubRepositories(input: {
  repos: readonly string[];
  token?: string | undefined;
  fetch?: FetchLike;
}): Promise<CheckItem[]> {
  const fetchImpl = input.fetch ?? ((url, init) => fetch(url, init));
  const items: CheckItem[] = [];
  for (const repo of input.repos) {
    let status: number;
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repo}/pulls?state=all&per_page=1`,
        {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            "user-agent": "ggjira-router",
            "x-github-api-version": "2022-11-28",
            ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
          },
        },
      );
      status = response.status;
    } catch (error) {
      items.push({
        level: "warn",
        message: `GitHub ${repo}: cannot reach GitHub (${errorText(error)})`,
      });
      continue;
    }
    if (status === 200) {
      items.push({
        level: "ok",
        message: `GitHub ${repo}: pull requests are readable${input.token ? " with GITHUB_TOKEN" : " without a token"}`,
      });
    } else if (status === 404) {
      items.push({
        level: "fail",
        message: input.token
          ? `GitHub ${repo}: GITHUB_TOKEN cannot see this repository (give it Pull requests: read); merges are not noticed`
          : `GitHub ${repo}: not visible without a token; a private repository needs GITHUB_TOKEN, or merges are not noticed`,
      });
    } else if (status === 401) {
      items.push({ level: "fail", message: `GitHub ${repo}: GITHUB_TOKEN is invalid or expired` });
    } else {
      items.push({
        level: "warn",
        message: `GitHub ${repo}: GitHub answered ${status}${status === 403 || status === 429 ? " (rate limited or forbidden)" : ""}`,
      });
    }
  }
  return items;
}

export async function runRouterCheck(
  jira: JiraGateway,
  config: RouterConfig,
  opts: {
    issueKey?: string;
    /** GitHub repositories to check (`githubRepositoriesToCheck`) and the token Router polls with. */
    github?: { repos: readonly string[]; token?: string | undefined; fetch?: FetchLike };
  } = {},
): Promise<CheckItem[]> {
  const items: CheckItem[] = [];
  try {
    const me = await jira.getMyself();
    items.push({ level: "ok", message: `Jira authentication works (as ${me.displayName})` });
  } catch (error) {
    items.push({ level: "fail", message: `Jira authentication failed: ${errorText(error)}` });
    return items;
  }

  for (const workspace of config.workspaces) {
    for (const projectKey of workspace.projectKeys) {
      await checkProject(jira, config, workspace, projectKey, items);
    }
  }

  if (config.executionAgent) {
    const fieldId = config.executionAgent.fieldId;
    try {
      const fields = await jira.listFields();
      items.push(
        fields.some((field) => field.id === fieldId)
          ? { level: "ok", message: `executionAgent.fieldId ${fieldId} exists` }
          : { level: "fail", message: `executionAgent.fieldId ${fieldId} is not a Jira field` },
      );
    } catch (error) {
      items.push({ level: "fail", message: `cannot list Jira fields (${errorText(error)})` });
    }
  }

  if (config.workers.length === 0) {
    items.push({
      level: "warn",
      message: "no workers declared in config; nothing can be dispatched",
    });
  }

  if (opts.github) items.push(...(await checkGithubRepositories(opts.github)));
  if (opts.issueKey) await checkSampleIssue(jira, config, opts.issueKey, items);
  return items;
}
