import { createHash, randomUUID } from "node:crypto";
import type { RouterDatabase } from "./db/connection.js";
import { z } from "zod";
import {
  FCI_ANALYZER,
  FCI_AXES,
  FCI_LABELS,
  FCI_NOTICE,
  FCI_RUBRIC,
  FCI_VERSION,
  type FciOutcome,
  type FciSnapshot,
  type FciTask,
  FciTaskSchema,
  ShaSchema,
  normalizedFci,
  rawFci,
} from "../contracts/fci.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { RouterConfig } from "./config.js";
import { roleSystemPrompt } from "./prompt-catalog.js";
import { appendRoleInstructions } from "../contracts/prompts.js";
import { buildFciSystemPrompt } from "../worker/fci-prompt.js";
import { structuralFindings } from "../worker/fci-static.js";
import type { FciFacts } from "../worker/fci-facts.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (statusCode: number, message: string): never => {
  throw Object.assign(new Error(message), { statusCode });
};
type Row = Record<string, string | number | null> & {
  id: string;
  purpose: string;
  status: string;
  before_sha: string;
  after_sha: string;
  baseline_sha: string;
  error: string | null;
  pr_repo: string | null;
  superseded: number;
  supersedes: string | null;
  revision: number;
  series_id: string;
  lease_expires_at: string | null;
  repo: string;
  number: number;
  sha: string;
};
export class FciService {
  constructor(
    private db: RouterDatabase,
    private config: RouterConfig,
    private now: () => string = () => new Date().toISOString(),
  ) {}
  setConfig(config: RouterConfig) {
    this.config = config;
  }
  enabled(repo: string) {
    return this.config.repositories.find((r) => r.id === repo)?.fci?.enabled === true;
  }
  private series(repoId: string): Row | undefined {
    const repo = this.config.repositories.find((r) => r.id === repoId);
    const cfg = repo?.fci;
    if (
      !repo ||
      !cfg?.enabled ||
      !cfg.baselineSha ||
      (cfg.ruleVersion !== FCI_VERSION && !cfg.modelId)
    )
      return;
    const staticAnalysis = cfg.ruleVersion === FCI_VERSION;
    const systemPrompt = appendRoleInstructions(
      buildFciSystemPrompt(),
      this.config.prompts.fci_analysis.additionalInstructions,
    );
    const profile = {
      analyzer: FCI_ANALYZER,
      ruleVersion: cfg.ruleVersion,
      weights: staticAnalysis ? undefined : cfg.weights,
      ...(staticAnalysis
        ? {
            structuralWeights: {
              coupling: 0.25,
              complexity: 0.25,
              duplication: 0.25,
              ripple: 0.25,
            },
          }
        : {}),
      model: staticAnalysis ? "static" : cfg.modelId,
      providerType: staticAnalysis ? "codex" : cfg.providerType,
      promptHash: staticAnalysis ? "not-applicable" : hash(systemPrompt),
      systemPrompt: staticAnalysis ? "" : systemPrompt,
      staticAnalysis,
      historyLimit: 200,
      baseBranch: repo.baseBranch ?? "main",
    };
    const profileKey = hash(profile);
    const id = hash([repoId, cfg.baselineSha, profileKey]);
    this.db
      .prepare("INSERT OR IGNORE INTO fci_series VALUES (?,?,?,?,?,?)")
      .run(id, repoId, cfg.baselineSha, profileKey, JSON.stringify(profile), this.now());
    return this.db.prepare("SELECT * FROM fci_series WHERE id=?").get(id) as Row;
  }
  private enqueue(
    s: Row,
    input: {
      key: string;
      purpose: string;
      before: string;
      after: string;
      prRepo?: string | null;
      prNumber?: number | null;
      issueKey?: string | null;
      jobId?: string | null;
      sourceAttempt?: string | null;
      mergeSha?: string | null;
      commits?: string[];
      originalBase?: string | null;
      revision?: number;
      supersedes?: string;
    },
  ) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO fci_tasks (id,request_key,series_id,purpose,before_sha,after_sha,pr_repo,pr_number,issue_key,job_id,source_attempt_id,merge_sha,pr_commits,original_base_sha,revision,supersedes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        hash([s.id, input.key]),
        s.id,
        input.purpose,
        input.before,
        input.after,
        input.prRepo ?? null,
        input.prNumber ?? null,
        input.issueKey ?? null,
        input.jobId ?? null,
        input.sourceAttempt ?? null,
        input.mergeSha ?? null,
        JSON.stringify(input.commits ?? []),
        input.originalBase ?? null,
        input.revision ?? 0,
        input.supersedes ?? null,
        this.now(),
        this.now(),
      );
  }
  /** Reconciliation is repeatable; no analysis is performed inside Router. */
  sync() {
    this.db
      .prepare(
        "UPDATE fci_tasks SET status='failed',error='analysis lease expired; retry analysis only',updated_at=? WHERE status='running' AND lease_expires_at<=?",
      )
      .run(this.now(), this.now());
    for (const repo of this.config.repositories) {
      const s = this.series(repo.id);
      if (!s) continue;
      if (JSON.parse(s.profile as string).staticAnalysis) {
        this.syncHistory(s);
        const state = this.db
          .prepare("SELECT tip,error FROM fci_history_state WHERE series_id=?")
          .get(s.id) as { tip: string | null; error: string | null };
        if (!state.tip || state.error) continue;
      }
      this.enqueue(s, {
        key: "baseline",
        purpose: "baseline",
        before: s.baseline_sha as string,
        after: s.baseline_sha as string,
      });
      const prs = this.db
        .prepare(
          "SELECT p.*,o.head_sha,o.base_sha,o.base_branch,o.commits,o.merge_sha AS actual_merge_sha,o.state AS observed_state FROM pull_requests p JOIN jobs j ON j.id=p.job_id JOIN fci_pr_observations o ON lower(o.repo)=lower(p.repo) AND o.number=p.number WHERE j.repository_id=? AND NOT EXISTS (SELECT 1 FROM job_inputs i WHERE i.job_id=j.id AND json_extract(i.snapshot,'$.planTask.parentKey') IS NOT NULL)",
        )
        .all(repo.id) as Row[];
      for (const p of prs) {
        if (p.observed_state === "closed") {
          this.db
            .prepare(
              "UPDATE fci_tasks SET superseded=1 WHERE pr_repo=? AND pr_number=? AND purpose='pr_preview'",
            )
            .run(p.repo, p.number);
          continue;
        }
        if (
          !p.head_sha ||
          !p.base_sha ||
          (p.base_branch !== repo.baseBranch && p.base_branch !== (repo.baseBranch ?? "main"))
        )
          continue;
        const merged = p.observed_state === "merged";
        if (!merged || !p.actual_merge_sha) continue;
        if (JSON.parse(s.profile as string).staticAnalysis) {
          const boundary = this.db
            .prepare(
              "SELECT automatic FROM fci_history_commits WHERE series_id=? AND sha=? AND active=1",
            )
            .get(s.id, p.actual_merge_sha) as { automatic: number } | undefined;
          if (!boundary?.automatic) continue; // Backfill never reports historical Jira issues.
        }
        const key = hash([
          p.repo,
          p.number,
          p.head_sha,
          p.base_sha,
          p.actual_merge_sha,
          p.observed_state,
        ]);
        this.enqueue(s, {
          key: `pr:${key}`,
          purpose: "merge_final",
          before: p.base_sha as string,
          after: p.head_sha as string,
          prRepo: p.repo as string,
          prNumber: p.number as number,
          issueKey: p.issue_key as string,
          jobId: p.job_id as string,
          sourceAttempt: p.attempt_id as string,
          mergeSha: p.actual_merge_sha as string | null,
          commits: JSON.parse(p.commits as string),
          originalBase: p.base_sha as string,
        });
        this.db
          .prepare(
            "UPDATE fci_tasks SET superseded=1 WHERE series_id=? AND pr_repo=? AND pr_number=? AND purpose='pr_preview' AND request_key<>?",
          )
          .run(s.id, p.repo, p.number, hash([s.id, `pr:${key}`]));
      }
    }
  }
  busy(workerId: string) {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM fci_tasks WHERE worker_id=? AND status='running' AND lease_expires_at>?",
        )
        .get(workerId, this.now()),
    );
  }
  private syncHistory(s: Row) {
    this.db.prepare("INSERT OR IGNORE INTO fci_history_state(series_id)VALUES (?)").run(s.id);
    const state = this.db
      .prepare("SELECT * FROM fci_history_state WHERE series_id=?")
      .get(s.id) as Row;
    const scan = this.db
      .prepare(
        "SELECT id,status FROM fci_tasks WHERE series_id=? AND purpose='history_scan' ORDER BY rowid DESC LIMIT 1",
      )
      .get(s.id) as Row | undefined;
    if (
      (!scan || !["queued", "running"].includes(scan.status)) &&
      (!state.scanned_at || Date.parse(this.now()) - Date.parse(String(state.scanned_at)) >= 60000)
    ) {
      this.enqueue(s, {
        key: `scan:${Math.floor(Date.parse(this.now()) / 60000)}`,
        purpose: "history_scan",
        before: s.baseline_sha,
        after: s.baseline_sha,
      });
    }
    if (state.error || !state.tip) return;
    const baseline = this.snapshot(s.id, s.baseline_sha);
    if (!baseline || rawFci(baseline.assessment, JSON.parse(s.profile as string).weights) === null)
      return;
    const existingTasks = new Map(
      (
        this.db
          .prepare(
            "SELECT after_sha,status FROM fci_tasks WHERE series_id=? AND purpose='commit' AND revision=0",
          )
          .all(s.id) as Array<{ after_sha: string; status: string }>
      ).map((t) => [t.after_sha, t]),
    );
    const commits = this.db
      .prepare(
        "SELECT * FROM fci_history_commits WHERE series_id=? AND active=1 AND ordinal>0 ORDER BY ordinal",
      )
      .all(s.id) as Row[];
    let backfillQueued = false;
    for (const c of commits) {
      const automatic = Boolean(c.automatic);
      const existing = existingTasks.get(String(c.sha));
      if (existing) {
        if (["queued", "running"].includes(existing.status) && !automatic) backfillQueued = true;
        continue;
      }
      if (
        !automatic &&
        (state.mode === "paused" ||
          Number(c.ordinal) > Number(state.through_order) ||
          backfillQueued)
      )
        continue;
      this.enqueue(s, {
        key: `commit:${c.sha}`,
        purpose: "commit",
        before: String(c.sha),
        after: String(c.sha),
      });
      if (!automatic) backfillQueued = true;
    }
  }
  historyControl(repoId: string, action: string, sha?: string) {
    const s = this.series(repoId);
    if (!s || !JSON.parse(s.profile as string).staticAnalysis)
      return fail(409, "정적 FCI를 먼저 활성화해 주세요.");
    this.syncHistory(s);
    if (["pause", "all", "next", "resume"].includes(action)) {
      const state = this.db
        .prepare("SELECT tip,through_order FROM fci_history_state WHERE series_id=?")
        .get(s.id) as { tip: string | null; through_order: number | null };
      if (action !== "pause" && !state.tip)
        return fail(409, "Worker가 이력을 확인한 뒤 평가를 시작해 주세요.");
      const missing = this.db
        .prepare(
          "SELECT c.ordinal FROM fci_history_commits c WHERE c.series_id=? AND c.active=1 AND c.ordinal>0 AND NOT EXISTS(SELECT 1 FROM fci_tasks t WHERE t.series_id=c.series_id AND t.after_sha=c.sha AND t.purpose='commit' AND t.status IN ('succeeded','failed','unassessable')) ORDER BY c.ordinal",
        )
        .all(s.id) as { ordinal: number }[];
      const through =
        action === "next"
          ? missing[0]?.ordinal
          : action === "resume"
            ? (state.through_order ?? missing.at(-1)?.ordinal)
            : action === "pause"
              ? undefined
              : missing.at(-1)?.ordinal;
      this.db
        .prepare(
          "UPDATE fci_history_state SET mode=?,through_order=COALESCE(?,through_order) WHERE series_id=?",
        )
        .run(action === "pause" ? "paused" : "all", through ?? null, s.id);
      this.syncHistory(s);
      return { accepted: true };
    }
    if (action === "explain" && sha) {
      const snapshot = this.snapshot(s.id, sha);
      if (!snapshot?.assessment.structural || snapshot.assessment.structural.raw === null)
        return fail(409, "평가를 완료한 커밋을 선택해 주세요.");
      this.enqueue(s, {
        key: `explain:${sha}:${hash(roleSystemPrompt("fci_analysis", this.config.prompts))}`,
        purpose: "explain",
        before: sha,
        after: sha,
      });
      return { accepted: true };
    }
    return fail(400, "알 수 없는 FCI 동작입니다.");
  }
  historyView(repoId: string, offset = 0, limit = 100) {
    this.sync();
    const s = this.series(repoId);
    if (!s) return { series: null, commits: [], total: 0, state: null };
    const profile = JSON.parse(s.profile as string);
    const base = this.snapshot(s.id, s.baseline_sha);
    const baseRaw = base ? rawFci(base.assessment, profile.weights) : null;
    const rows = this.db
      .prepare(
        "SELECT * FROM fci_history_commits WHERE series_id=? AND active=1 ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(s.id, Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as Row[];
    const latest = this.db
      .prepare(
        "SELECT c.sha,c.ordinal,p.raw_score FROM fci_history_commits c JOIN fci_snapshots p ON p.series_id=c.series_id AND p.sha=c.sha AND p.revision=0 WHERE c.series_id=? AND c.active=1 AND p.raw_score IS NOT NULL ORDER BY c.ordinal DESC LIMIT 1",
      )
      .get(s.id) as { sha: string; ordinal: number; raw_score: number } | undefined;
    return {
      latest: latest
        ? {
            sha: latest.sha,
            ordinal: latest.ordinal,
            fci: normalizedFci(latest.raw_score, baseRaw),
          }
        : null,
      series: { id: s.id, baselineSha: s.baseline_sha, profile },
      state: this.db.prepare("SELECT * FROM fci_history_state WHERE series_id=?").get(s.id),
      total: (
        this.db
          .prepare("SELECT COUNT(*) n FROM fci_history_commits WHERE series_id=? AND active=1")
          .get(s.id) as { n: number }
      ).n,
      completed: (
        this.db
          .prepare(
            "SELECT COUNT(*) n FROM fci_history_commits c JOIN fci_snapshots p ON p.series_id=c.series_id AND p.sha=c.sha AND p.revision=0 WHERE c.series_id=? AND c.active=1 AND p.raw_score IS NOT NULL",
          )
          .get(s.id) as { n: number }
      ).n,
      commits: rows.map((c) => {
        const snapshot = this.snapshot(s.id, String(c.sha));
        const previous = c.parent_sha ? this.snapshot(s.id, String(c.parent_sha)) : null;
        const raw = snapshot ? rawFci(snapshot.assessment, profile.weights) : null;
        const oldRaw = previous ? rawFci(previous.assessment, profile.weights) : null;
        const task = this.db
          .prepare(
            "SELECT id,status,error FROM fci_tasks WHERE series_id=? AND after_sha=? AND revision=0 AND purpose IN ('commit','baseline') ORDER BY rowid DESC LIMIT 1",
          )
          .get(s.id, c.sha) as Row | undefined;
        return {
          ...c,
          sha: String(c.sha),
          parent_sha: c.parent_sha,
          ordinal: Number(c.ordinal),
          taskId: task?.id,
          status: task?.status ?? (snapshot ? "succeeded" : "missing"),
          error: task?.error,
          fci: normalizedFci(raw, baseRaw),
          delta: raw === null || oldRaw === null ? null : raw - oldRaw,
          axes: Object.fromEntries(
            Object.entries(snapshot?.assessment.structural?.axes ?? {}).map(([axis, value]) => {
              const b = base?.assessment.structural?.axes[axis as "coupling"];
              return [axis, value === null || b == null ? null : 100 + value - b];
            }),
          ),
          confidence: snapshot?.assessment.structural?.confidence,
        };
      }),
    };
  }
  historyDetail(repoId: string, sha: string) {
    const s = this.series(repoId);
    if (!s) return fail(404, "unknown FCI series");
    const commit = this.db
      .prepare("SELECT * FROM fci_history_commits WHERE series_id=? AND sha=?")
      .get(s.id, sha) as Row | undefined;
    if (!commit) return fail(404, "unknown commit");
    const snapshot = this.snapshot(s.id, sha);
    const previous = commit.parent_sha ? this.snapshot(s.id, String(commit.parent_sha)) : null;
    const repo = this.config.repositories.find((r) => r.id === repoId);
    const remote = repo?.cloneUrl?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1];
    const findings = snapshot?.assessment.structural
      ? structuralFindings(
          snapshot.facts as unknown as FciFacts,
          previous?.facts as unknown as FciFacts | undefined,
        )
      : [];
    const axes = snapshot?.assessment.structural?.axes;
    const before = previous?.assessment.structural?.axes;
    findings.sort(
      (a, b) =>
        Math.abs((axes?.[b.axis] ?? 0) - (before?.[b.axis] ?? 0)) -
        Math.abs((axes?.[a.axis] ?? 0) - (before?.[a.axis] ?? 0)),
    );
    return {
      commit,
      snapshot,
      previous,
      jiraBaseUrl: this.config.jira.baseUrl,
      findings: findings.slice(0, 3).map((f) => ({
        ...f,
        url: remote
          ? `https://github.com/${remote}/blob/${f.sha ?? sha}/${f.path.split("/").map(encodeURIComponent).join("/")}#L${f.line}`
          : null,
      })),
      explanations: this.db
        .prepare(
          "SELECT id,status,error,outcome FROM fci_tasks WHERE series_id=? AND after_sha=? AND purpose='explain' ORDER BY rowid DESC",
        )
        .all(s.id, sha),
      prs: this.db
        .prepare(
          "SELECT pr_repo,pr_number,issue_key FROM fci_tasks WHERE series_id=? AND after_sha=? AND purpose='merge_final' UNION SELECT p.repo AS pr_repo,p.number AS pr_number,p.issue_key FROM pull_requests p JOIN fci_pr_observations o ON lower(o.repo)=lower(p.repo) AND o.number=p.number JOIN jobs j ON j.id=p.job_id WHERE j.repository_id=? AND o.merge_sha=? AND o.state='merged'",
        )
        .all(s.id, sha, repoId, sha),
    };
  }
  next(
    workerId: string,
    sessionId: string,
    requestId: string,
    providers: Array<{ id: string; model?: string | undefined; type?: string | undefined }>,
  ): FciTask | null {
    this.sync();
    return this.db.transaction(() => {
      const now = this.now();
      this.db
        .prepare(
          "UPDATE fci_tasks SET status='failed',error='analysis lease expired; retry analysis only',updated_at=? WHERE status='running' AND lease_expires_at<=?",
        )
        .run(now, now);
      const replay = this.db
        .prepare(
          "SELECT * FROM fci_tasks WHERE worker_id=? AND session_id=? AND attempt_id=? AND status='running'",
        )
        .get(workerId, sessionId, requestId) as Row | undefined;
      if (replay) return JSON.parse(replay.envelope as string);
      if (
        this.busy(workerId) ||
        this.db
          .prepare(
            "SELECT 1 FROM attempts WHERE worker_id=? AND state IN ('leased','running','cancel_requested','recovery_required')",
          )
          .get(workerId)
      )
        return null;
      if (this.db.prepare("SELECT 1 FROM jobs WHERE state IN ('queued','leased')").get())
        return null;
      const policy = this.config.workers.find((w) => w.workerId === workerId && w.enabled);
      if (!policy) return null;
      const provider = providers.find((p) => p.id === policy.providerId);
      const pending = this.db
        .prepare(
          "SELECT t.*,s.repository_id,s.baseline_sha,s.profile_key,s.profile FROM fci_tasks t JOIN fci_series s ON s.id=t.series_id WHERE t.status='queued' AND t.superseded=0 ORDER BY CASE WHEN t.purpose='baseline' THEN 0 ELSE 1 END,t.created_at,t.rowid",
        )
        .all() as Row[];
      for (const t of pending) {
        if (
          !this.enabled(t.repository_id as string) ||
          !policy.allowedRepositoryIds.includes(t.repository_id as string)
        )
          continue;
        const current = this.series(t.repository_id as string);
        if (current?.id !== t.series_id) continue;
        const profile = JSON.parse(t.profile as string);
        if (
          !profile.staticAnalysis &&
          (!provider?.model ||
            profile.model !== provider.model ||
            (provider.type && profile.providerType !== provider.type))
        )
          continue;
        if (t.purpose === "explain" && !provider) continue;
        if (profile.staticAnalysis && t.purpose === "commit") {
          const state = this.db
            .prepare("SELECT * FROM fci_history_state WHERE series_id=?")
            .get(t.series_id) as Row;
          if (state.error) continue;
          const c = this.db
            .prepare(
              "SELECT ordinal,active,automatic FROM fci_history_commits WHERE series_id=? AND sha=?",
            )
            .get(t.series_id, t.after_sha) as
            | { ordinal: number; active: number; automatic: number }
            | undefined;
          const retried =
            Number(t.revision) > 0 ||
            Boolean(
              this.db.prepare("SELECT 1 FROM fci_attempts WHERE task_id=? LIMIT 1").get(t.id),
            );
          if (
            !c?.active ||
            (!retried &&
              !c.automatic &&
              (state.mode === "paused" || c.ordinal > Number(state.through_order)))
          )
            continue;
        }
        const repo = this.config.repositories.find((r) => r.id === t.repository_id);
        const task = FciTaskSchema.parse({
          id: t.id,
          attemptId: requestId,
          leaseToken: randomUUID(),
          repositoryId: t.repository_id,
          providerId: provider?.id ?? policy.providerId,
          model: profile.staticAnalysis ? "static" : provider?.model,
          staticAnalysis: profile.staticAnalysis ?? false,
          ...(t.purpose === "explain"
            ? {
                explanationSnapshot: this.snapshot(t.series_id as string, t.after_sha),
                explanationPrevious: (() => {
                  const c = this.db
                    .prepare(
                      "SELECT parent_sha FROM fci_history_commits WHERE series_id=? AND sha=?",
                    )
                    .get(t.series_id, t.after_sha) as { parent_sha: string } | undefined;
                  return c
                    ? (this.snapshot(t.series_id as string, c.parent_sha) ?? undefined)
                    : undefined;
                })(),
              }
            : {}),
          providerType: profile.providerType,
          seriesId: t.series_id,
          profileKey: t.profile_key,
          purpose: t.purpose,
          baseBranch: profile.baseBranch,
          baselineSha: t.baseline_sha,
          beforeSha: t.before_sha,
          afterSha: t.after_sha,
          prRepo: t.pr_repo,
          prNumber: t.pr_number,
          issueKey: t.issue_key,
          systemPrompt:
            t.purpose === "explain"
              ? roleSystemPrompt("fci_analysis", this.config.prompts)
              : profile.systemPrompt,
          weights: profile.weights ?? {},
          timeoutMs: repo?.fci?.timeoutMs ?? 600000,
          revision: t.revision,
          mergeSha: t.merge_sha,
          prCommits: JSON.parse(t.pr_commits as string),
          originalBaseSha: t.original_base_sha,
          validationEvidence: t.job_id
            ? (() => {
                const row = this.db
                  .prepare(
                    "SELECT payload FROM results WHERE job_id=? AND applied=1 ORDER BY received_at DESC LIMIT 1",
                  )
                  .get(t.job_id) as { payload: string } | undefined;
                const result = row ? JSON.parse(row.payload) : null;
                const sha = result?.git?.headSha ?? result?.git?.baseSha;
                return sha
                  ? (result.validation ?? []).map((summary: string) => ({
                      sha,
                      summary,
                      source: "implementation",
                    }))
                  : [];
              })()
            : [],
        });
        this.db
          .prepare(
            "UPDATE fci_tasks SET status='running',worker_id=?,session_id=?,attempt_id=?,lease_token=?,lease_expires_at=?,envelope=?,updated_at=? WHERE id=?",
          )
          .run(
            workerId,
            sessionId,
            requestId,
            task.leaseToken,
            new Date(Date.parse(now) + 30000).toISOString(),
            JSON.stringify(task),
            now,
            t.id,
          );
        this.db
          .prepare(
            "INSERT INTO fci_attempts (id,task_id,worker_id,lease_token,envelope,created_at) VALUES (?,?,?,?,?,?)",
          )
          .run(
            hash([workerId, sessionId, requestId]),
            t.id,
            workerId,
            task.leaseToken,
            JSON.stringify(task),
            now,
          );
        return task;
      }
      return null;
    })();
  }
  lease(workerId: string, taskId: string, token: string, sessionId?: string): Row {
    const t = this.db
      .prepare(
        "SELECT t.*,s.repository_id FROM fci_tasks t JOIN fci_series s ON s.id=t.series_id WHERE t.id=?",
      )
      .get(taskId) as Row | undefined;
    if (!t || t.worker_id !== workerId || t.lease_token !== token)
      return fail(409, "FCI lease does not match");
    if (sessionId && t.session_id !== sessionId) return fail(409, "FCI session does not match");
    if (t.status !== "running" || String(t.lease_expires_at) <= this.now())
      return fail(409, "FCI lease is no longer active");
    return t;
  }
  beat(workerId: string, id: string, token: string, sessionId: string) {
    const t = this.lease(workerId, id, token, sessionId);
    const current = this.series(t.repository_id as string);
    const cancel =
      !this.enabled(t.repository_id as string) ||
      Boolean(t.superseded) ||
      current?.id !== t.series_id;
    this.db
      .prepare("UPDATE fci_tasks SET lease_expires_at=? WHERE id=?")
      .run(new Date(Date.parse(this.now()) + 30000).toISOString(), id);
    this.db
      .prepare("UPDATE fci_snapshot_claims SET expires_at=? WHERE task_id=? AND token=?")
      .run(new Date(Date.parse(this.now()) + 30000).toISOString(), id, token);
    return { cancel };
  }
  lookup(
    workerId: string,
    id: string,
    token: string,
    sessionId: string,
    sha: string,
  ): FciSnapshot | null {
    const t = this.lease(workerId, id, token, sessionId);
    const snapshot = this.snapshot(t.series_id as string, sha);
    const series = this.db
      .prepare("SELECT profile FROM fci_series WHERE id=?")
      .get(t.series_id) as { profile: string };
    if (
      t.revision === 0 &&
      snapshot &&
      rawFci(snapshot.assessment, JSON.parse(series.profile).weights) !== null
    )
      return snapshot;
    const claim = this.db
      .prepare("SELECT * FROM fci_snapshot_claims WHERE series_id=? AND sha=? AND revision=?")
      .get(t.series_id, sha, t.revision) as Row | undefined;
    if (claim && claim.token !== token && String(claim.expires_at) > this.now())
      return fail(425, "Identical snapshot is being analyzed; wait for its cached result");
    this.db
      .prepare("INSERT OR REPLACE INTO fci_snapshot_claims VALUES (?,?,?,?,?,?)")
      .run(t.series_id, sha, t.revision, id, token, t.lease_expires_at);
    return null;
  }
  snapshot(seriesId: string, sha: string, revision = 0): FciSnapshot | null {
    const row = this.db
      .prepare("SELECT payload FROM fci_snapshots WHERE series_id=? AND sha=? AND revision=?")
      .get(seriesId, sha, revision) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  publish(workerId: string, id: string, token: string, sessionId: string, snapshot: FciSnapshot) {
    const t = this.lease(workerId, id, token, sessionId);
    const row = this.db.prepare("SELECT profile FROM fci_series WHERE id=?").get(t.series_id) as {
      profile: string;
    };
    const profile = JSON.parse(row.profile);
    if (snapshot.model !== profile.model)
      return fail(400, "Snapshot model differs from FCI profile");
    this.db
      .prepare(
        "INSERT INTO fci_snapshots VALUES (?,?,?,?,?) ON CONFLICT(series_id,sha,revision) DO UPDATE SET payload=excluded.payload,raw_score=excluded.raw_score WHERE fci_snapshots.raw_score IS NULL AND excluded.raw_score IS NOT NULL",
      )
      .run(
        t.series_id,
        snapshot.sha,
        t.revision,
        JSON.stringify(snapshot),
        rawFci(snapshot.assessment, profile.weights),
      );
    this.db
      .prepare("DELETE FROM fci_snapshot_claims WHERE task_id=? AND token=? AND sha=?")
      .run(id, token, snapshot.sha);
    return { accepted: true };
  }
  finish(workerId: string, id: string, token: string, resultId: string, outcome: FciOutcome) {
    const historical = this.db
      .prepare("SELECT * FROM fci_attempts WHERE task_id=? AND worker_id=? AND lease_token=?")
      .get(id, workerId, token) as Row | undefined;
    if (!historical) return fail(409, "unknown FCI attempt");
    if (historical.result_id) {
      if (historical.result_id !== resultId || historical.outcome !== JSON.stringify(outcome))
        return fail(409, "conflicting FCI result replay");
      return { accepted: true };
    }
    const current = this.db.prepare("SELECT * FROM fci_tasks WHERE id=?").get(id) as Row;
    if (
      current.lease_token !== token ||
      current.status !== "running" ||
      String(current.lease_expires_at) <= this.now()
    ) {
      this.db
        .prepare("UPDATE fci_attempts SET result_id=?,outcome=? WHERE id=?")
        .run(resultId, JSON.stringify(outcome), historical.id);
      return { accepted: true };
    }
    const prior = this.db
      .prepare("SELECT worker_id,lease_token,result_id,outcome FROM fci_tasks WHERE id=?")
      .get(id) as Row | undefined;
    if (
      prior?.result_id === resultId &&
      prior.worker_id === workerId &&
      prior.lease_token === token
    ) {
      if (prior.outcome !== JSON.stringify(outcome))
        return fail(409, "conflicting FCI result replay");
      return { accepted: true };
    }
    const t = this.lease(workerId, id, token);
    const series = this.db.prepare("SELECT * FROM fci_series WHERE id=?").get(t.series_id) as Row;
    const profile = JSON.parse(series.profile as string);
    if (outcome.snapshots.some((s) => s.model !== profile.model))
      return fail(400, "FCI model differs from profile");
    this.db.transaction(() => {
      if (t.purpose === "history_scan") {
        const parsed = z
          .object({
            tip: ShaSchema,
            baselineSha: ShaSchema,
            commits: z.array(
              z.object({
                sha: ShaSchema,
                parent: ShaSchema.nullable(),
                title: z.string(),
                date: z.string(),
              }),
            ),
          })
          .safeParse(outcome.change);
        if (outcome.status === "succeeded" && parsed.success) {
          const { tip, commits } = parsed.data;
          if (
            !parsed.data.baselineSha.startsWith(series.baseline_sha) ||
            commits[0]?.sha !== parsed.data.baselineSha ||
            commits.at(-1)?.sha !== tip ||
            commits.some((c, i) => i > 0 && c.parent !== commits[i - 1]?.sha)
          )
            return fail(400, "Invalid first-parent history");
          this.db
            .prepare("UPDATE fci_series SET baseline_sha=? WHERE id=?")
            .run(parsed.data.baselineSha, series.id);
          this.db
            .prepare("UPDATE fci_history_commits SET active=0 WHERE series_id=?")
            .run(series.id);
          const state = this.db
            .prepare("SELECT initial_tip FROM fci_history_state WHERE series_id=?")
            .get(series.id) as { initial_tip: string | null };
          const insert = this.db.prepare(
            "INSERT INTO fci_history_commits(series_id,sha,parent_sha,ordinal,title,committed_at,active,automatic)VALUES(?,?,?,?,?,?,1,?) ON CONFLICT(series_id,sha) DO UPDATE SET ordinal=excluded.ordinal,active=1",
          );
          commits.forEach((c, i) =>
            insert.run(series.id, c.sha, c.parent, i, c.title, c.date, state.initial_tip ? 1 : 0),
          );
          this.db
            .prepare(
              "UPDATE fci_history_state SET tip=?,initial_tip=COALESCE(initial_tip,?),scanned_at=?,error=NULL WHERE series_id=?",
            )
            .run(tip, tip, this.now(), series.id);
        } else
          this.db
            .prepare("UPDATE fci_history_state SET scanned_at=?,error=? WHERE series_id=?")
            .run(this.now(), outcome.reason ?? "이력 조회 실패", series.id);
      }
      this.db.prepare("DELETE FROM fci_snapshot_claims WHERE task_id=? AND token=?").run(id, token);
      this.db
        .prepare("UPDATE fci_attempts SET result_id=?,outcome=? WHERE id=?")
        .run(resultId, JSON.stringify(outcome), historical.id);
      for (const snapshot of outcome.snapshots)
        this.db
          .prepare(
            "INSERT INTO fci_snapshots VALUES (?,?,?,?,?) ON CONFLICT(series_id,sha,revision) DO UPDATE SET payload=excluded.payload,raw_score=excluded.raw_score WHERE fci_snapshots.raw_score IS NULL AND excluded.raw_score IS NOT NULL",
          )
          .run(
            t.series_id,
            snapshot.sha,
            t.revision,
            JSON.stringify(snapshot),
            rawFci(snapshot.assessment, profile.weights),
          );
      this.db
        .prepare(
          "UPDATE fci_tasks SET status=?,result_id=?,outcome=?,error=?,before_sha=COALESCE(?,before_sha),after_sha=COALESCE(?,after_sha),boundary=?,updated_at=? WHERE id=?",
        )
        .run(
          outcome.status,
          resultId,
          JSON.stringify(outcome),
          outcome.reason ?? null,
          outcome.beforeSha ?? null,
          outcome.afterSha ?? null,
          outcome.boundary ?? null,
          this.now(),
          id,
        );
      if (t.issue_key && this.enabled(t.repository_id as string) && !t.superseded)
        this.db
          .prepare("INSERT OR IGNORE INTO fci_reports(task_id,updated_at)VALUES (?,?)")
          .run(id, this.now());
    })();
    return { accepted: true };
  }
  retry(id: string, force = false) {
    const t = this.db.prepare("SELECT * FROM fci_tasks WHERE id=?").get(id) as Row | undefined;
    if (!t) return fail(404, "unknown FCI analysis");
    if (["task_result", "pr_preview"].includes(t.purpose))
      return fail(409, "Pre-merge analysis is retired; evaluate the merged parent PR instead");
    const original = t.envelope ? FciTaskSchema.parse(JSON.parse(t.envelope as string)) : null;
    if (t.status === "running") return fail(409, "analysis is running");
    if (force) {
      const s = this.db.prepare("SELECT * FROM fci_series WHERE id=?").get(t.series_id) as Row;
      this.enqueue(s, {
        key: `manual:${randomUUID()}`,
        purpose: t.purpose as string,
        before: original?.beforeSha ?? t.before_sha,
        after: original?.afterSha ?? t.after_sha,
        prRepo: t.pr_repo as string | null,
        prNumber: t.pr_number as number | null,
        issueKey: t.issue_key as string | null,
        jobId: t.job_id as string | null,
        sourceAttempt: t.source_attempt_id as string | null,
        mergeSha: t.merge_sha as string | null,
        commits: JSON.parse(t.pr_commits as string),
        originalBase: t.original_base_sha as string | null,
        revision: Date.now(),
        supersedes: id,
      });
    } else {
      if (!["failed", "unassessable"].includes(t.status as string))
        return fail(409, "only failed or unassessable analyses can retry; use explicit reanalysis");
      this.db
        .prepare(
          "UPDATE fci_tasks SET status='queued',result_id=NULL,outcome=NULL,error=NULL,before_sha=?,after_sha=?,updated_at=? WHERE id=?",
        )
        .run(
          original?.beforeSha ?? t.before_sha,
          original?.afterSha ?? t.after_sha,
          this.now(),
          id,
        );
      this.db.prepare("DELETE FROM fci_reports WHERE task_id=?").run(id);
    }
    return { accepted: true };
  }
  retryReport(id: string) {
    if (!this.db.prepare("SELECT 1 FROM fci_reports WHERE task_id=?").get(id))
      return fail(404, "unknown FCI report");
    this.db
      .prepare("UPDATE fci_reports SET status='pending',error=NULL,updated_at=? WHERE task_id=?")
      .run(this.now(), id);
    return { accepted: true };
  }
  detail(id: string) {
    const t = this.db
      .prepare(
        "SELECT t.*,s.repository_id,s.baseline_sha,s.profile FROM fci_tasks t JOIN fci_series s ON s.id=t.series_id WHERE t.id=?",
      )
      .get(id) as Row | undefined;
    if (!t) return fail(404, "unknown FCI analysis");
    const profile = JSON.parse(t.profile as string);
    const rev = t.revision as number;
    const recorded = t.outcome ? (JSON.parse(t.outcome as string) as FciOutcome) : null;
    const before = recorded
      ? (recorded.snapshots.find((s) => s.sha === t.before_sha) ?? null)
      : this.snapshot(t.series_id as string, t.before_sha as string, rev);
    const after = recorded
      ? (recorded.snapshots.find((s) => s.sha === t.after_sha) ?? null)
      : this.snapshot(t.series_id as string, t.after_sha as string, rev);
    const baseline = this.snapshot(t.series_id as string, t.baseline_sha as string);
    const rawBefore = before ? rawFci(before.assessment, profile.weights) : null;
    const rawAfter = after ? rawFci(after.assessment, profile.weights) : null;
    const base = baseline ? rawFci(baseline.assessment, profile.weights) : null;
    const beforeFci = normalizedFci(rawBefore, base);
    const afterFci = normalizedFci(rawAfter, base);
    return {
      ...t,
      profile,
      outcome: recorded,
      before,
      after,
      baseline,
      rawBefore,
      rawAfter,
      beforeFci,
      afterFci,
      delta: beforeFci === null || afterFci === null ? null : afterFci - beforeFci,
      attempts: this.db
        .prepare(
          "SELECT id,result_id,outcome,created_at FROM fci_attempts WHERE task_id=? ORDER BY created_at",
        )
        .all(id),
      report: this.db.prepare("SELECT * FROM fci_reports WHERE task_id=?").get(id) ?? null,
    };
  }
  view(repositoryId?: string, summaryOnly = false) {
    this.sync();
    const series = this.db
      .prepare(
        `SELECT * FROM fci_series ${repositoryId ? "WHERE repository_id=?" : ""} ORDER BY created_at DESC`,
      )
      .all(...(repositoryId ? [repositoryId] : [])) as Row[];
    const tasks = this.db
      .prepare(
        `SELECT t.id,t.series_id,s.repository_id,t.purpose,t.status,t.after_sha FROM fci_tasks t JOIN fci_series s ON s.id=t.series_id ${repositoryId ? "WHERE s.repository_id=?" : ""} ORDER BY t.created_at DESC,t.rowid DESC`,
      )
      .all(...(repositoryId ? [repositoryId] : [])) as { id: string }[];
    return {
      pollErrors: this.db.prepare("SELECT * FROM fci_poll_errors").all(),
      notice: FCI_NOTICE,
      rubric: FCI_RUBRIC,
      axes: FCI_LABELS,
      repositories: this.config.repositories.map((r) => ({
        id: r.id,
        displayName: r.displayName,
        baseBranch: r.baseBranch ?? "main",
        fci: r.fci ?? { enabled: false },
      })),
      series: series.map((s) => ({ ...s, profile: JSON.parse(s.profile as string) })),
      records: summaryOnly ? tasks : [],
      analyses: summaryOnly ? [] : tasks.map((t) => this.detail(t.id)),
    };
  }
  forJob(jobId: string) {
    return (
      this.db
        .prepare("SELECT id FROM fci_tasks WHERE job_id=? ORDER BY created_at DESC")
        .all(jobId) as { id: string }[]
    ).map((t) => this.detail(t.id));
  }
  private comment(id: string): string {
    const d = this.detail(id);
    const n = (v: number | null) => (v === null ? "평가 불가" : v.toFixed(2));
    const lines = [
      FCI_NOTICE,
      `${d.purpose === "merge_final" ? "병합 후 확정 분석" : "잠정·예상 분석"} / ${d.status}`,
      `SHA: ${d.before_sha} → ${d.after_sha}`,
      `FCI: ${n(d.beforeFci)} → ${n(d.afterFci)} / ΔFCI ${n(d.delta)}`,
      `원점수: ${n(d.rawBefore)} → ${n(d.rawAfter)}`,
      `추적 기준: ${d.baseline_sha}`,
      `분석: ${d.id} / 규칙 ${d.profile.ruleVersion} / ${d.profile.analyzer} / 모델 ${d.profile.model}`,
      String(d.error ?? ""),
    ];
    if (d.after) {
      lines.push(
        d.after.assessment.summary,
        ...d.after.assessment.unverified.map((x) => `미검증: ${x}`),
      );
      if (d.after.assessment.structural) {
        const axes = d.after.assessment.structural.axes;
        const old = d.before?.assessment.structural?.axes;
        for (const [axis, title] of Object.entries({
          coupling: "의존성",
          complexity: "복잡도",
          duplication: "중복",
          ripple: "변경 파급",
        }))
          lines.push(
            `${title}: ${n(old?.[axis as keyof typeof axes] ?? null)} → ${n(axes[axis as keyof typeof axes])}`,
          );
        for (const f of structuralFindings(
          d.after.facts as unknown as FciFacts,
          d.before?.facts as unknown as FciFacts | undefined,
        ).slice(0, 3))
          lines.push(
            `${f.explanation}\n근거: ${d.pr_repo ? `https://github.com/${d.pr_repo}/blob/${d.after.sha}/${f.path.split("/").map(encodeURIComponent).join("/")}#L${f.line}` : `${f.path}:${f.line}`}\n개선: ${f.suggestion}`,
          );
        lines.push(
          "정적 평가는 테스트를 실행하지 않습니다. 연결된 통합 검증 결과를 별도로 확인하세요.",
        );
        return lines.join("\n");
      }
      for (const axis of FCI_AXES) {
        const a = d.after.assessment.axes[axis];
        const b = d.before?.assessment.axes[axis];
        lines.push(
          `${FCI_LABELS[axis]}: ${b?.grade ?? "평가 불가"} → ${a.grade ?? "평가 불가"} / 신뢰도 ${a.confidence}: ${a.explanation}`,
          ...a.uncertainties.map((x) => `불확실성: ${x}`),
        );
        for (const e of a.evidence)
          lines.push(
            `근거: ${d.pr_repo ? `https://github.com/${d.pr_repo}/blob/${d.after.sha}/${e.path.split("/").map(encodeURIComponent).join("/")}#L${e.line}` : `${e.path}:${e.line}`} — ${e.explanation}`,
          );
      }
      lines.push(
        ...d.after.assessment.priorities.map((p) => `개선 우선순위 ${p.priority}: ${p.suggestion}`),
      );
    }
    return lines.join("\n");
  }
  async report(jira: JiraGateway) {
    const reports = this.db
      .prepare(
        "SELECT r.task_id,t.issue_key,s.repository_id,t.series_id FROM fci_reports r JOIN fci_tasks t ON t.id=r.task_id JOIN fci_series s ON s.id=t.series_id WHERE r.status='pending' AND t.superseded=0",
      )
      .all() as { task_id: string; issue_key: string; repository_id: string; series_id: string }[];
    for (const r of reports) {
      if (!this.enabled(r.repository_id) || this.series(r.repository_id)?.id !== r.series_id)
        continue;
      try {
        const marker = `[GGJIRA:FCI:${r.task_id}]`;
        const comments = await jira.getComments(r.issue_key);
        const body = `${marker}\n${this.comment(r.task_id)}`;
        const existing = comments.find((c) => c.body.includes(marker));
        if (!existing) await jira.addComment(r.issue_key, body);
        else if (existing.body !== body) {
          if (!jira.updateComment)
            throw new Error("Jira comment update is unavailable; report not duplicated");
          await jira.updateComment(r.issue_key, existing.id, body);
        }
        this.db
          .prepare(
            "UPDATE fci_reports SET status='applied',error=NULL,updated_at=? WHERE task_id=?",
          )
          .run(this.now(), r.task_id);
      } catch (error) {
        this.db
          .prepare("UPDATE fci_reports SET status='failed',error=?,updated_at=? WHERE task_id=?")
          .run(error instanceof Error ? error.message : String(error), this.now(), r.task_id);
      }
    }
  }
}
