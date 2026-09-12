import {
  existsSync,
  mkdirSync,
  rmSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { JiraIssue } from "../jira/types.js";
import type { Job } from "./job.js";

interface StateFile {
  claims: Record<string, string>;
  handled?: Record<string, string>;
}

interface LeaseFile {
  runId: string;
  pid: number;
  startedAt: string;
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
  private readonly leasesDir: string;
  private readonly handledDir: string;

  constructor(dataDir = "data") {
    this.dataDir = dataDir;
    this.statePath = path.join(dataDir, "state.json");
    this.leasesDir = path.join(dataDir, "leases");
    this.handledDir = path.join(dataDir, "handled");
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
    return readJsonFile(this.statePath, () => ({ claims: {}, handled: {} }));
  }

  private writeState(state: StateFile): void {
    writeJsonFileAtomic(this.statePath, state);
  }

  listClaims(): Record<string, string> {
    if (!existsSync(this.leasesDir)) return { ...this.readState().claims };
    const claims: Record<string, string> = {};
    for (const entry of readdirSync(this.leasesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const issueKey = decodeURIComponent(entry.name);
      const lease = this.readLease(issueKey);
      if (lease) claims[issueKey] = lease.runId;
    }
    return claims;
  }

  getClaim(issueKey: string): string | undefined {
    return this.readState().claims[issueKey];
  }

  private issueFingerprint(issue: JiraIssue): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          statusName: issue.statusName,
          assigneeAccountId: issue.assigneeAccountId,
          description: issue.description,
          updatedAt: issue.updatedAt,
        }),
      )
      .digest("hex");
  }

  wasHandled(issue: JiraIssue): boolean {
    const marker = path.join(this.handledDir, `${encodeURIComponent(issue.key)}.txt`);
    if (existsSync(marker)) return readFileSync(marker, "utf-8") === this.issueFingerprint(issue);
    return this.readState().handled?.[issue.key] === this.issueFingerprint(issue);
  }

  markHandled(issue: JiraIssue): void {
    mkdirSync(this.handledDir, { recursive: true });
    writeFileSync(
      path.join(this.handledDir, `${encodeURIComponent(issue.key)}.txt`),
      this.issueFingerprint(issue),
    );
  }

  private leaseDir(issueKey: string): string {
    return path.join(this.leasesDir, encodeURIComponent(issueKey));
  }

  private readLease(issueKey: string): LeaseFile | undefined {
    const leasePath = path.join(this.leaseDir(issueKey), "owner.json");
    if (!existsSync(leasePath)) return undefined;
    try {
      return JSON.parse(readFileSync(leasePath, "utf-8")) as LeaseFile;
    } catch {
      return undefined;
    }
  }

  isClaimOwnedByLiveProcess(issueKey: string): boolean {
    const lease = this.readLease(issueKey);
    if (!lease) return false;
    try {
      process.kill(lease.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Claims an issue for the given run, persisted to state.json so a restarted
   * process refuses to claim the same issue twice. Returns false (no-op) if
   * the issue is already claimed by a different run.
   */
  claimIssue(issueKey: string, runId: string): boolean {
    mkdirSync(this.leasesDir, { recursive: true });
    const leaseDir = this.leaseDir(issueKey);
    try {
      mkdirSync(leaseDir);
      writeFileSync(
        path.join(leaseDir, "owner.json"),
        JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() }),
      );
    } catch (error) {
      const existing = this.readLease(issueKey);
      if (existing?.runId === runId) return true;
      return false;
    }

    const state = this.readState();
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
    rmSync(this.leaseDir(issueKey), { recursive: true, force: true });
  }
}
