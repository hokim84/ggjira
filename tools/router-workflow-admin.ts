import { JiraClient } from "../src/jira/client.js";
import { loadRouterConfig } from "../src/router/config.js";
import { loadRouterSecrets } from "../src/router/secrets.js";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openRouterDb } from "../src/router/db/connection.js";

const config = loadRouterConfig("router.config.json");
const secrets = loadRouterSecrets(process.env, "router.env");
const jira = new JiraClient({
  baseUrl: config.jira.baseUrl,
  email: secrets.jiraEmail,
  apiToken: secrets.jiraApiToken,
});
try {
  if (process.argv.includes("--reset-local-state")) {
    let listening = false;
    try {
      await fetch(`http://127.0.0.1:${config.http.port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      listening = true;
    } catch {}
    if (listening)
      throw new Error("Stop the Router and settle Worker executions before resetting test state.");
    const dbPath = path.resolve(config.db.path);
    if (!dbPath.startsWith(`${path.resolve(process.cwd())}${path.sep}`))
      throw new Error("Reset is limited to a database inside this workspace.");
    const db = openRouterDb(dbPath);
    try {
      const backups = path.join(path.dirname(dbPath), "backups");
      mkdirSync(backups, { recursive: true });
      const backup = path.join(backups, `before-board-workflow-${Date.now()}.sqlite3`);
      await db.backup(backup);
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
      )
        .map((row) => row.name)
        .filter(
          (name) => !name.startsWith("sqlite_") && !["schema_migrations", "workers"].includes(name),
        );
      db.pragma("foreign_keys=OFF");
      db.transaction(() => {
        for (const table of tables) {
          if (!/^[a-z_]+$/.test(table)) throw new Error("Unexpected database table name");
          db.exec(`DELETE FROM "${table}"`);
        }
        db.exec(
          "UPDATE workers SET current_session_id=NULL,last_seen_at=NULL,last_heartbeat_at=NULL,last_assigned_at=NULL,reported_repository_ids='[]',reported_repository_paths='{}'",
        );
        if ((db.pragma("foreign_key_check") as unknown[]).length)
          throw new Error("Reset foreign key check failed");
      })();
      db.pragma("foreign_keys=ON");
      console.log(
        JSON.stringify({
          reset: true,
          backup,
          preserved: "worker registrations and configuration",
        }),
      );
    } finally {
      db.close();
    }
    process.exit(0);
  }
  if (process.argv.includes("--local-status")) {
    const base = `http://127.0.0.1:${config.http.port}`;
    const response = await fetch(`${base}/api/v1/admin/status`, {
      headers: { Authorization: `Bearer ${secrets.adminToken}` },
      signal: AbortSignal.timeout(3000),
    });
    console.log(JSON.stringify({ localRouter: response.status, status: await response.json() }));
    process.exit(0);
  }
  console.log(JSON.stringify({ account: (await jira.getMyself()).displayName }));
  for (const workspace of config.workspaces)
    for (const project of workspace.projectKeys) {
      console.log(JSON.stringify({ project, statuses: await jira.listProjectStatuses(project) }));
      if (process.argv.includes("--apply"))
        console.log(
          JSON.stringify({
            project,
            provisioning: await jira.ensureAiWorkflow(project, workspace.workflow),
          }),
        );
    }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
