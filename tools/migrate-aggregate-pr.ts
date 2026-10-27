import { RouterDatabase } from "../src/router/db/connection.js";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadRouterConfig } from "../src/router/config.js";
import { loadRouterSecrets } from "../src/router/secrets.js";
import { JiraClient } from "../src/jira/client.js";
import { openRouterDb } from "../src/router/db/connection.js";
import { getActivePlanDeployment } from "../src/router/db/plan-delegation.js";
import { latestImplementation, verifiedImplementation } from "../src/router/workflow-checks.js";
import { computeInputHash, computeApprovalId } from "../src/router/approval.js";
import { assemblyContext } from "../src/router/assembly.js";
import type { ApprovalSnapshot } from "../src/router/issue-check.js";
import type { JobResult } from "../src/contracts/envelope.js";
import { readPlanTaskMetadata } from "../src/pm/metadata.js";
import { defaultWorkerHome, workerPaths } from "../src/worker-runtime/paths.js";

const apply = process.argv.includes("--apply");
const configPath = process.argv.find((a) => a.endsWith(".json")) ?? "router.config.json";
const config = loadRouterConfig(configPath);
let db = new RouterDatabase(config.db.path, { readOnly: true });
try {
  if (apply) {
    const listening = await fetch(`http://127.0.0.1:${config.http.port}/health`, {
      signal: AbortSignal.timeout(1500),
    }).then(
      () => true,
      () => false,
    );
    if (listening) throw new Error("Stop Router and Worker before applying this migration");
    if (
      db
        .prepare(
          "SELECT 1 FROM jobs WHERE state IN ('running','leased','cancel_requested','recovery_required') OR (state IN ('queued','waiting') AND kind IN ('planning','implementation','assemble_pr'))",
        )
        .get() ||
      db.prepare("SELECT 1 FROM fci_tasks WHERE status='running'").get()
    )
      throw new Error("Settle active executions before migration");
    const worker = workerPaths(process.env.GGJIRA_WORKER_HOME ?? defaultWorkerHome());
    if (existsSync(worker.config)) {
      for (const spool of [worker.spool, worker.fciSpool]) {
        if (existsSync(spool) && readdirSync(spool).some((name) => name.endsWith(".json")))
          throw new Error("Deliver Worker spools before migration");
      }
    }
    const backups = path.join(path.dirname(config.db.path), "backups");
    mkdirSync(backups, { recursive: true });
    const backup = path.join(backups, `before-aggregate-pr-${Date.now()}.sqlite3`);
    await db.backupTo(backup);
    copyFileSync(configPath, `${configPath}.before-aggregate-pr.bak`);
    db.close();
    db = openRouterDb(config.db.path);
    db.prepare(
      "UPDATE jobs SET state='cancelled',closed_at=?,updated_at=? WHERE kind IN ('integration_check','quality_review') AND state IN ('queued','waiting','failed','timed_out')",
    ).run(new Date().toISOString(), new Date().toISOString());
    console.log(JSON.stringify({ backup, protocol: 7, schema: 22 }));
  }
  const secrets = loadRouterSecrets(process.env, "router.env");
  const jira = new JiraClient({
    baseUrl: config.jira.baseUrl,
    email: secrets.jiraEmail,
    apiToken: secrets.jiraApiToken,
  });
  const deployments = db
    .prepare("SELECT issue_key FROM plan_deployments WHERE state='active'")
    .all() as { issue_key: string }[];
  for (const row of deployments) {
    const parent = await jira.getIssue(row.issue_key);
    const workspace = config.workspaces.find((w) =>
      w.projectKeys.includes(parent.projectKey ?? ""),
    );
    const deployment = getActivePlanDeployment(db, parent.key);
    if (!workspace || !deployment || parent.statusName === workspace.workflow.doneStatus) continue;
    const children = await jira.searchIssues(`parent = "${parent.key}"`, { all: true });
    const completedOverrides = new Set<string>();
    for (const child of children) {
      if (
        child.statusName !== workspace.workflow.integrationPendingStatus ||
        child.labels.includes("ggjira-superseded")
      )
        continue;
      const task = await readPlanTaskMetadata(jira, child.key);
      if (
        !task ||
        task.planVersion !== deployment.planVersion ||
        !deployment.taskIds.includes(task.taskId)
      )
        continue;
      const latest = latestImplementation(db, child.key);
      const frozen =
        latest &&
        (db
          .prepare(
            "SELECT snapshot FROM job_inputs WHERE job_id=(SELECT job_id FROM results WHERE id=?)",
          )
          .get(latest.id) as { snapshot: string } | undefined);
      if (!latest || !frozen) {
        console.log(
          JSON.stringify({ child: child.key, held: "No current approved implementation evidence" }),
        );
        continue;
      }
      const input = JSON.parse(frozen.snapshot) as ApprovalSnapshot;
      const result = JSON.parse(latest.payload) as JobResult;
      if (
        computeInputHash({
          kind: "implementation",
          issue: child,
          requirements: input.requirements,
          planTask: input.planTask,
        }) !== latest.input_hash ||
        !verifiedImplementation(result) ||
        !result.git?.headSha ||
        !result.branch ||
        !result.artifacts?.some((a) => a.startsWith("pushed:"))
      ) {
        console.log(
          JSON.stringify({ child: child.key, held: "Changed inputs or unpublished result" }),
        );
        continue;
      }
      console.log(
        JSON.stringify({
          child: child.key,
          to: workspace.workflow.implementationCompleteStatus,
          apply,
        }),
      );
      completedOverrides.add(child.key);
      if (apply)
        await jira.transitionIssueToStatus(
          child.key,
          workspace.workflow.implementationCompleteStatus,
        );
    }
    const ready = await assemblyContext(
      db,
      jira,
      workspace,
      parent,
      config.repositories.find((r) => r.id === workspace.repositoryId)?.baseBranch ?? "main",
      completedOverrides,
    );
    if (
      ready &&
      [
        workspace.workflow.planningInProgressStatus,
        workspace.workflow.integrationPendingStatus,
        workspace.workflow.implementationCompleteStatus,
      ].includes(parent.statusName)
    ) {
      console.log(
        JSON.stringify({
          parent: parent.key,
          to: workspace.workflow.inProgressStatus,
          reason:
            "Reconcile the preserved results into a parent aggregate PR; never rerun children automatically",
          apply,
        }),
      );
      if (apply) {
        await jira.transitionIssueToStatus(parent.key, workspace.workflow.inProgressStatus);
        const updated = await jira.getIssue(parent.key);
        db.prepare("INSERT OR REPLACE INTO parent_progress_entries VALUES (?,?)").run(
          parent.key,
          await computeApprovalId(jira, updated, workspace.workflow.inProgressStatus),
        );
      }
    }
  }
  console.log(JSON.stringify({ dryRun: !apply, parentsExamined: deployments.length }));
} finally {
  db.close();
}
