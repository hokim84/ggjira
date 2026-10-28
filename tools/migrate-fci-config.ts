import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { RouterConfigSchema } from "../src/router/config.js";

const configPath = path.resolve(
  process.argv.find((a) => a.endsWith(".json")) ?? "router.config.json",
);
const old = JSON.parse(readFileSync(configPath, "utf8"));
if (![6, 7].includes(old.configVersion))
  throw new Error("Only Router configVersion 6 or 7 can be converted");
const next = {
  ...old,
  configVersion: 7,
  workspaces: old.workspaces.map((w: { workflow: Record<string, unknown> }) => ({
    ...w,
    workflow: Object.fromEntries(Object.entries(w.workflow).filter(([k]) => k !== "reviewStatus")),
  })),
  prompts: {
    ...old.prompts,
    fci_analysis: old.prompts?.fci_analysis ?? { additionalInstructions: "" },
  },
};
next.prompts = Object.fromEntries(
  Object.entries(next.prompts).filter(([k]) => k !== "quality_review"),
);
const validated = RouterConfigSchema.parse(next);
if (process.argv.includes("--apply")) {
  const listening = await fetch(`http://127.0.0.1:${old.http?.port ?? 8787}/health`, {
    signal: AbortSignal.timeout(1000),
  }).then(
    () => true,
    () => false,
  );
  if (listening)
    throw new Error(
      "Stop the Router and settle Worker jobs/spools before applying the config migration",
    );
  const backup = `${configPath}.before-fci-${Date.now()}.json.bak`;
  copyFileSync(configPath, backup);
  writeFileSync(configPath, `${JSON.stringify(validated, null, 2)}\n`);
  console.log(
    JSON.stringify({
      updated: true,
      backup,
      configVersion: 7,
      fciEnabled: validated.repositories.some((r) => r.fci?.enabled),
    }),
  );
} else
  console.log(
    JSON.stringify({
      dryRun: true,
      configVersion: 7,
      removedReviewState: true,
      reviewInstructionsArchivedOnApply: true,
      repositoryIds: validated.repositories.map((r) => r.id),
    }),
  );
