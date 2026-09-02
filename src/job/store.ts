import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { Job } from "./job.js";

interface StateFile {
  claims: Record<string, string>;
}

function readJsonFile<T>(filePath: string, makeFallback: () => T): T {
  // makeFallback is a factory, not a value: the caller may mutate what comes
  // back (as claimIssue does), so returning a shared object here would leak
  // state across every JobStore instance whose file doesn't exist yet.
  if (!existsSync(filePath)) return makeFallback();
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

/** Writes via a temp file + rename so a crash mid-write never leaves a truncated file. */
function writeJsonFileAtomic(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  renameSync(tmpPath, filePath);
}

export class JobStore {
  private readonly dataDir: string;
  private readonly statePath: string;

  constructor(dataDir = "data") {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "state.json");
  }

  private runDir(issueKey: string, runId: string): string {
    return path.join(this.dataDir, "runs", issueKey, runId);
  }

  jobPath(issueKey: string, runId: string): string {
    return path.join(this.runDir(issueKey, runId), "job.json");
  }

  workerLogPath(issueKey: string, runId: string): string {
    return path.join(this.runDir(issueKey, runId), "worker.jsonl");
  }

  summaryPath(issueKey: string, runId: string): string {
    return path.join(this.runDir(issueKey, runId), "summary.md");
  }

  saveJob(job: Job): void {
    writeJsonFileAtomic(this.jobPath(job.issueKey, job.runId), job);
  }

  loadJob(issueKey: string, runId: string): Job | undefined {
    const filePath = this.jobPath(issueKey, runId);
    if (!existsSync(filePath)) return undefined;
    return JSON.parse(readFileSync(filePath, "utf-8")) as Job;
  }

  writeSummary(issueKey: string, runId: string, markdown: string): void {
    const filePath = this.summaryPath(issueKey, runId);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, markdown);
  }

  listIssueKeys(): string[] {
    const runsDir = path.join(this.dataDir, "runs");
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  listRunIds(issueKey: string): string[] {
    const issueDir = path.join(this.dataDir, "runs", issueKey);
    if (!existsSync(issueDir)) return [];
    return readdirSync(issueDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  private readState(): StateFile {
    return readJsonFile(this.statePath, () => ({ claims: {} }));
  }

  private writeState(state: StateFile): void {
    writeJsonFileAtomic(this.statePath, state);
  }

  listClaims(): Record<string, string> {
    return { ...this.readState().claims };
  }

  getClaim(issueKey: string): string | undefined {
    return this.readState().claims[issueKey];
  }

  /**
   * Claims an issue for the given run, persisted to state.json so a restarted
   * process refuses to claim the same issue twice. Returns false (no-op) if
   * the issue is already claimed by a different run.
   */
  claimIssue(issueKey: string, runId: string): boolean {
    const state = this.readState();
    const existing = state.claims[issueKey];
    if (existing !== undefined && existing !== runId) {
      return false;
    }
    state.claims[issueKey] = runId;
    this.writeState(state);
    return true;
  }

  releaseClaim(issueKey: string): void {
    const state = this.readState();
    if (issueKey in state.claims) {
      delete state.claims[issueKey];
      this.writeState(state);
    }
  }
}
