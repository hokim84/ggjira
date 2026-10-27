import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RouterDatabase } from "../src/router/db/connection.js";
import { RouterConfigSchema } from "../src/router/config.js";

const configPath = path.resolve(
  process.argv.find((a) => a.endsWith(".json")) ?? "router.config.json",
);
const old = JSON.parse(readFileSync(configPath, "utf8"));
const hasLegacy = old.repositories.some(
  (r: { fci?: { ruleVersion?: string } }) => r.fci && r.fci.ruleVersion !== "fci-static-v2",
);
const next = {
  ...old,
  repositories: old.repositories.map(
    (r: {
      fci?: { enabled?: boolean; baselineSha?: string; ruleVersion?: string };
      id: string;
    }) => ({
      ...r,
      ...(r.fci && r.fci.ruleVersion !== "fci-static-v2"
        ? {
            fci: {
              enabled: r.fci.enabled ?? false,
              baselineSha: r.fci.baselineSha,
              ruleVersion: "fci-static-v2",
            },
          }
        : {}),
    }),
  ),
  prompts: {
    ...old.prompts,
    fci_analysis: hasLegacy
      ? { additionalInstructions: "" }
      : (old.prompts?.fci_analysis ?? { additionalInstructions: "" }),
  },
};
const config = RouterConfigSchema.parse(next);
if (process.argv.includes("--apply")) {
  const listening = await fetch(`http://127.0.0.1:${old.http?.port ?? 8787}/health`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  if (listening)
    throw new Error(
      "Stop Router and Worker after draining active work and result spools before migration.",
    );
  const db = new RouterDatabase(path.resolve(path.dirname(configPath), old.db.path), {
    readOnly: true,
  });
  if (
    db
      .prepare(
        "SELECT 1 FROM jobs WHERE state IN ('running','leased','cancel_requested','recovery_required') LIMIT 1",
      )
      .get() ||
    db.prepare("SELECT 1 FROM fci_tasks WHERE status='running' LIMIT 1").get()
  ) {
    db.close();
    throw new Error("Active work remains; drain before migration.");
  }
  const backup = path.resolve(
    path.dirname(configPath),
    `data/backups/before-fci-static-${Date.now()}.sqlite3`,
  );
  const { mkdirSync } = await import("node:fs");
  mkdirSync(path.dirname(backup), { recursive: true });
  await db.backupTo(backup);
  db.close();
  const configBackup = `${configPath}.before-fci-static-${Date.now()}.bak`;
  copyFileSync(configPath, configBackup);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(JSON.stringify({ applied: true, backup, configBackup, protocol: 8 }));
} else
  console.log(
    JSON.stringify({
      dryRun: true,
      repositories: config.repositories.map((r) => ({
        id: r.id,
        enabled: r.fci?.enabled ?? false,
      })),
      protocol: 8,
      oldResultsPreserved: true,
      oldInstructionsArchivedInConfigBackup: true,
    }),
  );
