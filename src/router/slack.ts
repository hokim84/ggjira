import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { DecisionRequest } from "../contracts/decision.js";
import { PLAN_PROPERTY_KEY, PlanMetadataSchema, readPlanTaskMetadata } from "../pm/metadata.js";
import { appendAudit } from "./db/audit.js";
import type { RouterDatabase } from "./db/connection.js";
import {
  getLatestPlanReview,
  getReviewedPlan,
  listOpenPlanReviews,
  recordPlanDeployment,
} from "./db/plan-delegation.js";
import { listBatchReportSteps } from "./db/report-steps.js";
import type { RouterConfig } from "./config.js";
import {
  type PlanningRequest,
  latestPlanningRequest,
  planningFingerprint,
} from "./planning-requests.js";

type Row = Record<string, string | null>;
type SlackFetch = typeof fetch;
interface SlackMessage {
  text: string;
  blocks?: unknown[];
}
export interface SlackSecrets {
  botToken?: string | undefined;
  signingSecret?: string | undefined;
}
export interface SlackDeps {
  db: RouterDatabase;
  jira: JiraGateway;
  config: RouterConfig;
  secrets: SlackSecrets;
  now: () => string;
  fetch?: SlackFetch;
}

export function verifySlackSignature(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now: number,
): boolean {
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

function id(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function slackEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Only Router owns this integration. Inbox/outbox state survives restarts; no AI or Jira calls in HTTP handlers. */
export class SlackService {
  private config: RouterConfig;
  reconcileNeeded = false;
  constructor(private readonly deps: SlackDeps) {
    this.config = deps.config;
    this.setConfig(deps.config);
  }
  setConfig(config: RouterConfig): void {
    this.config = config;
    const active = config.slack?.enabled ? config.slack.workspaceIds : [];
    for (const row of this.deps.db.prepare("SELECT workspace_id FROM slack_activation").all()) {
      if (!active.includes(row.workspace_id as string))
        this.deps.db
          .prepare("DELETE FROM slack_activation WHERE workspace_id=?")
          .run(row.workspace_id as string);
    }
    for (const workspace of active)
      this.deps.db
        .prepare(
          "INSERT OR IGNORE INTO slack_activation VALUES (?,?,(SELECT COALESCE(MAX(rowid),0) FROM planning_requests))",
        )
        .run(workspace, this.deps.now());
  }
  enabled(): boolean {
    return Boolean(
      this.config.slack?.enabled && this.deps.secrets.botToken && this.deps.secrets.signingSecret,
    );
  }

  /** Store only events for this configured team. Verified by the HTTP transport before calling. */
  ingest(payload: unknown): void {
    if (!this.enabled() || !payload || typeof payload !== "object") return;
    const p = payload as Record<string, unknown>;
    const team =
      typeof p.team === "object" && p.team ? (p.team as Record<string, unknown>).id : p.team_id;
    if (team !== this.config.slack?.teamId) return;
    let message: Record<string, unknown>;
    let key: string;
    if (p.type === "event_callback") {
      const event = p.event as Record<string, unknown> | undefined;
      if (
        !event ||
        event.type !== "message" ||
        event.channel_type !== "im" ||
        event.bot_id ||
        event.subtype ||
        !event.thread_ts ||
        typeof event.text !== "string"
      )
        return;
      message = {
        user: event.user,
        channel: event.channel,
        thread: event.thread_ts,
        text: event.text,
      };
      key = `event:${String(p.event_id)}`;
      if (typeof p.event_id !== "string") return;
    } else if (p.type === "block_actions") {
      const action = (p.actions as Record<string, unknown>[] | undefined)?.[0];
      const container = p.container as Record<string, unknown> | undefined;
      const user = p.user as Record<string, unknown> | undefined;
      if (
        !action ||
        !String(action.action_id).startsWith("ggjira_choice_") ||
        typeof action.value !== "string" ||
        !container
      )
        return;
      let choice: { question: string; option: string };
      try {
        choice = JSON.parse(action.value);
      } catch {
        return;
      }
      if (!choice || typeof choice.question !== "string" || typeof choice.option !== "string")
        return;
      message = {
        user: user?.id,
        channel: container.channel_id,
        question: choice.question,
        option: choice.option,
      };
      key = `action:${id(JSON.stringify([user?.id, action.action_ts, choice]))}`;
    } else return;
    if (typeof message.user !== "string" || typeof message.channel !== "string") return;
    if (
      !this.deps.db
        .prepare("SELECT 1 FROM slack_threads WHERE channel=? AND user_id=?")
        .get(message.channel, message.user)
    )
      return;
    this.deps.db
      .prepare("INSERT OR IGNORE INTO slack_inbox(id,payload,created_at) VALUES (?,?,?)")
      .run(key, JSON.stringify(message), this.deps.now());
  }

  status() {
    const db = this.deps.db;
    return {
      ready: this.enabled(),
      pending: db.prepare("SELECT COUNT(*) AS n FROM slack_outbox WHERE sent_at IS NULL").get()
        ?.n as number,
      errors: db
        .prepare(
          "SELECT 'delivery' AS kind,id,error FROM slack_outbox WHERE error IS NOT NULL UNION ALL SELECT 'thread',id,error FROM slack_threads WHERE error IS NOT NULL UNION ALL SELECT 'input',id,error FROM slack_inbox WHERE error IS NOT NULL UNION ALL SELECT 'workflow',id,error FROM slack_errors",
        )
        .all(),
    };
  }

  async tick(): Promise<void> {
    this.reconcileNeeded = false;
    if (!this.enabled()) return;
    await this.discover();
    await this.flush();
    await this.receive();
    await this.autoStart();
    await this.notifyJobs();
    await this.flush();
  }

  private async api(
    method: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await (this.deps.fetch ?? fetch)(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.deps.secrets.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Slack HTTP ${response.status}`);
    const data = (await response.json()) as Record<string, unknown>;
    if (!data.ok)
      throw new Error(
        `Slack ${method}: ${String(data.error ?? "invalid_response")
          .replace(/[^a-z_]/gi, "")
          .slice(0, 80)}`,
      );
    return data;
  }
  private enqueue(thread: string, key: string, message: SlackMessage): void {
    this.deps.db
      .prepare("INSERT OR IGNORE INTO slack_outbox(id,thread_id,payload) VALUES (?,?,?)")
      .run(key, thread, JSON.stringify(message));
  }
  private sent(key: string): boolean {
    return Boolean(
      this.deps.db.prepare("SELECT sent_at FROM slack_outbox WHERE id=?").get(key)?.sent_at,
    );
  }
  private async mirror(issue: string, key: string, body: string): Promise<void> {
    const marker = `[GGJIRA:SLACK:${key}]`;
    if (!(await this.deps.jira.getComments(issue)).some((comment) => comment.body.includes(marker)))
      await this.deps.jira.addComment(issue, `${body}\n\n${marker}`);
  }
  private async discover(): Promise<void> {
    const { db, jira } = this.deps;
    for (const workspace of this.config.workspaces) {
      if (!this.config.slack?.workspaceIds.includes(workspace.id)) continue;
      const activation = db
        .prepare("SELECT * FROM slack_activation WHERE workspace_id=?")
        .get(workspace.id);
      if (!activation) continue;
      const requests = db
        .prepare(
          "SELECT * FROM planning_requests p WHERE created_at>=? AND rowid>? AND rowid=(SELECT MAX(rowid) FROM planning_requests WHERE issue_key=p.issue_key)",
        )
        .all(activation.cutoff as string, activation.request_rowid as number) as Row[];
      for (const request of requests) {
        if (!request.issue_key || !request.id) continue;
        db.prepare("DELETE FROM slack_errors WHERE id=?").run(`discover:${request.id}`);
        try {
          const issue = await jira.getIssue(request.issue_key);
          if (!workspace.projectKeys.includes(issue.projectKey ?? "")) continue;
          const user = this.config.slack.users.find(
            (entry) => entry.jiraAccountId === issue.assigneeAccountId,
          );
          if (!user || !issue.assigneeAccountId) continue;
          const answeredThread = request.source_comment_id?.startsWith("slack:")
            ? (db
                .prepare(
                  "SELECT q.thread_id FROM slack_answers a JOIN slack_questions q ON q.id=a.question_id JOIN slack_threads t ON t.id=q.thread_id WHERE a.id=? AND t.owner=?",
                )
                .get(request.source_comment_id.slice(6), issue.assigneeAccountId)?.thread_id as
                | string
                | undefined)
            : undefined;
          const threadId =
            request.decision || request.source_comment_id?.startsWith("slack:")
              ? (answeredThread ??
                (db
                  .prepare(
                    "SELECT id FROM slack_threads WHERE issue_key=? AND owner=? ORDER BY rowid DESC LIMIT 1",
                  )
                  .get(issue.key, issue.assigneeAccountId)?.id as string | undefined) ??
                `${request.id}:${user.slackUserId}`)
              : `${request.id}:${user.slackUserId}`;
          db.prepare(
            "INSERT OR IGNORE INTO slack_threads(id,issue_key,workspace_id,request_id,owner,user_id,created_at) VALUES (?,?,?,?,?,?,?)",
          ).run(
            threadId,
            issue.key,
            workspace.id,
            request.id,
            issue.assigneeAccountId,
            user.slackUserId,
            this.deps.now(),
          );
          db.prepare("UPDATE slack_threads SET request_id=? WHERE id=?").run(request.id, threadId);
          db.prepare("INSERT OR REPLACE INTO slack_thread_requests VALUES (?,?)").run(
            request.id,
            threadId,
          );
          this.enqueue(threadId, `root:${threadId}`, {
            text: `${issue.key} · ${slackEscape(issue.summary)}\n<${this.config.jira.baseUrl}/browse/${encodeURIComponent(issue.key)}|Jira에서 보기>\n현재 상태: ${slackEscape(issue.statusName)}\n질문·답변과 작업 진행을 이 스레드에 기록합니다.`,
          });
          const review = getLatestPlanReview(db, issue.key);
          if (!review || review.requestApprovalId !== request.id || review.closedAt) continue;
          const plan = getReviewedPlan(db, review.id);
          if (!plan) continue;
          if (review.outcome === "needs_decision" && plan.decision) {
            const qid = id(`${review.id}:${threadId}`);
            db.prepare(
              "INSERT OR IGNORE INTO slack_questions(id,thread_id,request_id,source_id,issue_key,plan_version,options) VALUES (?,?,?,?,?,?,?)",
            ).run(
              qid,
              threadId,
              request.id,
              review.id,
              issue.key,
              review.planVersion,
              JSON.stringify(plan.decision.options),
            );
            const text = this.questionText(plan.decision);
            // The canonical question was journaled to Jira by the result processor; wait for it.
            if (
              !listBatchReportSteps(db, review.id).some(
                (step) => step.kind === "comment" && step.status === "applied",
              )
            )
              continue;
            this.enqueue(threadId, `question:${qid}`, {
              text,
              blocks: this.questionBlocks(qid, plan.decision),
            });
          } else if (review.outcome === "planned" && request.ready_history) {
            const text = `계획 확정 · ${review.planVersion}\n${plan.summary}\n${plan.tasks.map((task, index) => `${index + 1}. ${task.title}`).join("\n")}\n확인 기준: ${(plan.acceptanceCriteria ?? []).join(" / ")}\n추가 질문이 없어 구현을 자동 시작합니다.`;
            if (
              !db
                .prepare("SELECT 1 FROM slack_outbox WHERE id=?")
                .get(`plan:${review.id}:${threadId}`)
            )
              await this.mirror(issue.key, `plan:${review.id}`, text);
            this.enqueue(threadId, `plan:${review.id}:${threadId}`, { text: slackEscape(text) });
          }
        } catch {
          db.prepare("INSERT OR REPLACE INTO slack_errors VALUES (?,?)").run(
            `discover:${request.id}`,
            "Jira 질문·플랜 게시 확인 실패: 다시 시도 중",
          );
        }
      }
    }
  }
  private questionBlocks(qid: string, question: DecisionRequest): unknown[] {
    return [
      {
        type: "section",
        text: { type: "mrkdwn", text: slackEscape(this.questionText(question)).slice(0, 3000) },
      },
      ...Array.from(
        { length: Math.ceil(Math.min(question.options.length, 100) / 5) },
        (_, group) => ({
          type: "actions",
          elements: question.options
            .slice(group * 5, group * 5 + 5)
            .filter((option) => JSON.stringify({ question: qid, option: option.id }).length <= 2000)
            .map((option, offset) => ({
              type: "button",
              action_id: `ggjira_choice_${offset}`,
              text: {
                type: "plain_text",
                text: `${question.options.indexOf(option) + 1}. ${option.title}`.slice(0, 75),
              },
              value: JSON.stringify({ question: qid, option: option.id }),
            })),
        }),
      ),
    ].filter((block) => !("elements" in block) || Boolean(block.elements?.length));
  }

  private questionText(question: DecisionRequest): string {
    return [
      `결정 필요: ${question.question}`,
      ...question.options.map(
        (option, index) =>
          `${index + 1}. ${option.title}\n장점: ${option.pros.join(" / ")}\n단점: ${option.cons.join(" / ")}`,
      ),
      question.recommendation
        ? `추천: ${question.options.findIndex((option) => option.id === question.recommendation) + 1}`
        : "",
      question.impact ?? "",
      "버튼, 번호 또는 수정 의견을 이 스레드에 남겨주세요.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  private async flush(): Promise<void> {
    const { db } = this.deps;
    const rows = db
      .prepare(
        "SELECT o.*,t.channel,t.thread_ts,t.issue_key,t.user_id,t.owner FROM slack_outbox o JOIN slack_threads t ON t.id=o.thread_id WHERE sent_at IS NULL AND (retry_at IS NULL OR retry_at<=?) ORDER BY o.rowid",
      )
      .all(this.deps.now()) as Row[];
    for (const row of rows) {
      if (!row.id || !row.thread_id) continue;
      try {
        const issue = await this.deps.jira.getIssue(row.issue_key as string);
        if (
          issue.assigneeAccountId !== row.owner ||
          !this.config.slack?.users.some(
            (user) => user.jiraAccountId === row.owner && user.slackUserId === row.user_id,
          )
        )
          continue;
        const thread = db
          .prepare("SELECT * FROM slack_threads WHERE id=?")
          .get(row.thread_id) as Row;
        let channel = thread.channel;
        if (!channel) {
          const opened = await this.api("conversations.open", { users: row.user_id });
          channel = (opened.channel as { id: string }).id;
          db.prepare("UPDATE slack_threads SET channel=? WHERE id=?").run(channel, row.thread_id);
        }
        if (!thread.thread_ts && !row.id.startsWith("root:")) continue;
        const posted = await this.api("chat.postMessage", {
          ...JSON.parse(row.payload as string),
          channel,
          ...(thread.thread_ts ? { thread_ts: thread.thread_ts } : {}),
          client_msg_id: `${id(row.id).slice(0, 8)}-${id(row.id).slice(8, 12)}-4${id(row.id).slice(13, 16)}-8${id(row.id).slice(17, 20)}-${id(row.id).slice(20, 32)}`,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!posted.ts) throw new Error("Slack missing message timestamp");
        db.transaction(() => {
          if (!thread.thread_ts)
            db.prepare("UPDATE slack_threads SET thread_ts=?,error=NULL WHERE id=?").run(
              posted.ts as string,
              row.thread_id as string,
            );
          db.prepare("UPDATE slack_outbox SET sent_at=?,error=NULL WHERE id=?").run(
            this.deps.now(),
            row.id as string,
          );
        })();
      } catch {
        // Do not store token-bearing network errors or response bodies.
        db.prepare(
          "UPDATE slack_outbox SET error='Slack delivery failed',tries=tries+1,retry_at=? WHERE id=?",
        ).run(new Date(Date.parse(this.deps.now()) + 30_000).toISOString(), row.id);
      }
    }
  }

  private async receive(): Promise<void> {
    const { db, jira } = this.deps;
    for (const row of db
      .prepare("SELECT * FROM slack_inbox WHERE status='pending' ORDER BY rowid")
      .all() as Row[]) {
      const input = JSON.parse(row.payload as string) as {
        user: string;
        channel: string;
        thread?: string;
        question?: string;
        option?: string;
        text?: string;
      };
      let question = input.question
        ? (db
            .prepare(
              "SELECT q.*,t.owner,t.user_id,t.channel FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id WHERE q.id=?",
            )
            .get(input.question) as Row | undefined)
        : (db
            .prepare(
              "SELECT q.*,t.owner,t.user_id,t.channel FROM slack_questions q JOIN slack_threads t ON t.id=q.thread_id WHERE t.channel=? AND t.thread_ts=? ORDER BY q.rowid DESC LIMIT 1",
            )
            .get(input.channel, input.thread ?? "") as Row | undefined);
      let ambiguous = false;
      if (!input.question) {
        const prefix = input.text?.match(/^([A-Za-z][A-Za-z0-9_]*-\d+):\s*([\s\S]+)$/);
        const pending = db
          .prepare(`SELECT q.*,t.owner,t.user_id,t.channel FROM slack_questions q
          JOIN slack_threads t ON t.id=q.thread_id WHERE t.channel=? AND t.thread_ts=? AND q.answered_by IS NULL AND (
            (q.kind='planning' AND q.source_id=(SELECT id FROM plan_reviews WHERE issue_key=q.issue_key AND closed_at IS NULL ORDER BY rowid DESC LIMIT 1)
              AND q.request_id=(SELECT id FROM planning_requests WHERE issue_key=q.issue_key ORDER BY rowid DESC LIMIT 1)) OR
            (q.kind='implementation' AND q.job_id=(SELECT id FROM jobs WHERE issue_key=q.issue_key ORDER BY rowid DESC LIMIT 1))
          ) ORDER BY q.rowid DESC`)
          .all(input.channel, input.thread ?? "") as Row[];
        const candidates = prefix
          ? pending.filter((item) => item.issue_key === prefix[1]?.toUpperCase())
          : pending;
        if (candidates.length === 1) {
          question = candidates[0];
          if (prefix) input.text = prefix[2] ?? "";
        }
        ambiguous = candidates.length > 1 || Boolean(prefix && candidates.length === 0);
      }
      const reject = (reason: string) => {
        db.prepare("UPDATE slack_inbox SET status='ignored',error=? WHERE id=?").run(
          reason,
          row.id as string,
        );
        if (question?.thread_id && input.user === question.user_id)
          this.enqueue(question.thread_id, `ignored:${row.id}`, { text: reason });
      };
      if (!question || question.user_id !== input.user || question.channel !== input.channel) {
        reject("현재 담당자의 질문 스레드가 아닙니다.");
        continue;
      }
      if (ambiguous) {
        reject(
          "여러 질문이 대기 중입니다. 해당 질문의 버튼을 누르거나 '이슈키: 답변' 형식으로 남겨주세요.",
        );
        continue;
      }
      if (
        db.prepare("SELECT consumed FROM slack_answers WHERE id=?").get(row.id as string)?.consumed
      ) {
        db.prepare("UPDATE slack_inbox SET status='processed',error=NULL WHERE id=?").run(
          row.id as string,
        );
        continue;
      }
      try {
        const issue = await jira.getIssue(question.issue_key as string);
        const request =
          latestPlanningRequest(db, issue.key) ??
          (question.kind === "implementation"
            ? (db
                .prepare("SELECT * FROM planning_requests WHERE id=?")
                .get(question.request_id as string) as unknown as PlanningRequest | undefined)
            : undefined);
        const review = getLatestPlanReview(db, issue.key);
        const workspace = this.config.workspaces.find((item) =>
          item.projectKeys.includes(issue.projectKey ?? ""),
        );
        const implementation = question.kind === "implementation";
        const latestJob = implementation
          ? db
              .prepare("SELECT id,state FROM jobs WHERE issue_key=? ORDER BY rowid DESC LIMIT 1")
              .get(issue.key)
          : undefined;
        if (
          !request ||
          !workspace ||
          !this.config.slack?.workspaceIds.includes(workspace.id) ||
          issue.assigneeAccountId !== question.owner ||
          !this.config.slack.users.some(
            (user) => user.jiraAccountId === question.owner && user.slackUserId === input.user,
          ) ||
          request.id !== question.request_id ||
          (!implementation && review?.id !== question.source_id) ||
          (implementation &&
            (latestJob?.id !== question.job_id || latestJob?.state !== "succeeded")) ||
          (implementation ? question.input_hash : request.input_hash) !==
            planningFingerprint(issue) ||
          !(
            implementation
              ? [workspace.workflow.inProgressStatus, workspace.workflow.requestStatus]
              : [workspace.workflow.requestStatus, workspace.workflow.planningInProgressStatus]
          ).includes(issue.statusName)
        ) {
          reject("이 질문은 만료되었습니다. 현재 담당자와 최신 플랜을 확인해주세요.");
          continue;
        }
        if (question.answered_by && question.answered_by !== row.id) {
          reject("이미 답변을 접수한 질문입니다. 다음 질문을 기다려주세요.");
          continue;
        }
        const options = JSON.parse(question.options as string) as DecisionRequest["options"];
        const number = input.text?.trim().match(/^(\d+)\s*(?:번)?$/)?.[1];
        const option = input.option
          ? options.find((item) => item.id === input.option)
          : number
            ? options[Number(number) - 1]
            : undefined;
        if ((input.option || number) && !option) {
          reject("선택지에 있는 번호를 입력해주세요.");
          continue;
        }
        const body = option
          ? `${options.indexOf(option) + 1}. ${option.title}`
          : input.text?.trim();
        if (!body) {
          reject("답변 내용을 입력해주세요.");
          continue;
        }
        db.transaction(() => {
          db.prepare(
            "INSERT OR IGNORE INTO slack_answers(id,question_id,body,option_id) VALUES (?,?,?,?)",
          ).run(row.id as string, question.id as string, body, option?.id ?? null);
          db.prepare(
            "UPDATE slack_questions SET answered_by=? WHERE id=? AND answered_by IS NULL",
          ).run(row.id as string, question.id as string);
        })();
        await this.mirror(
          issue.key,
          row.id as string,
          `Slack 답변 · ${question.owner} (${input.user})\nplanVersion: ${question.plan_version}\n${body}`,
        );
        if (input.option)
          this.enqueue(question.thread_id as string, `answer:${row.id}`, {
            text: `답변 · <@${input.user}>\n${slackEscape(body)}`,
          });
        // A button click must also become a readable Slack reply before it resumes planning.
        if (input.option && !this.sent(`answer:${row.id}`)) {
          await this.flush();
          if (!this.sent(`answer:${row.id}`)) continue;
        }
        db.prepare("UPDATE slack_answers SET mirrored=1 WHERE id=?").run(row.id as string);
        if (implementation)
          await jira.transitionIssueToStatus(issue.key, workspace.workflow.requestStatus);
        db.transaction(() => {
          db.prepare("UPDATE slack_inbox SET status='processed',error=NULL WHERE id=?").run(
            row.id as string,
          );
          appendAudit(db, {
            at: this.deps.now(),
            actor: `slack:${input.user}`,
            action: "slack.answer",
            subject: issue.key,
            detail: { questionId: question.id, eventId: row.id },
          });
        })();
        this.reconcileNeeded = true;
      } catch {
        db.prepare("UPDATE slack_inbox SET error='답변 처리 실패: 다시 시도 중' WHERE id=?").run(
          row.id as string,
        );
      }
    }
  }

  private async autoStart(): Promise<void> {
    const { db, jira } = this.deps;
    for (const workspace of this.config.workspaces) {
      if (!this.config.slack?.workspaceIds.includes(workspace.id)) continue;
      for (const review of listOpenPlanReviews(db, workspace.id)) {
        if (review.outcome !== "planned") continue;
        db.prepare("DELETE FROM slack_errors WHERE id=?").run(`approve:${review.id}`);
        try {
          const request = latestPlanningRequest(db, review.issueKey);
          if (request?.id !== review.requestApprovalId || !request.ready_history) continue;
          const thread = db
            .prepare(
              "SELECT t.* FROM slack_threads t JOIN slack_thread_requests r ON r.thread_id=t.id WHERE r.request_id=?",
            )
            .get(request.id) as Row | undefined;
          if (!thread || !this.sent(`plan:${review.id}:${thread.id}`)) continue;
          const parent = await jira.getIssue(review.issueKey);
          if (
            parent.assigneeAccountId !== thread.owner ||
            !this.config.slack.users.some(
              (user) => user.jiraAccountId === thread.owner && user.slackUserId === thread.user_id,
            ) ||
            planningFingerprint(parent) !== request.input_hash
          )
            continue;
          if (
            ![
              workspace.workflow.requestStatus,
              workspace.workflow.planningInProgressStatus,
              workspace.workflow.inProgressStatus,
            ].includes(parent.statusName)
          )
            continue;
          const property = PlanMetadataSchema.safeParse(
            await jira.getIssueProperty(parent.key, PLAN_PROPERTY_KEY),
          );
          if (!property.success || property.data.version !== review.planVersion) continue;
          const taskIds = property.data.taskIds;
          const targets: JiraIssue[] = [];
          if (taskIds.length) {
            for (const child of await jira.searchIssues(`parent = "${parent.key}"`, {
              all: true,
            })) {
              const metadata = await readPlanTaskMetadata(jira, child.key);
              if (
                metadata?.planVersion === review.planVersion &&
                taskIds.includes(metadata.taskId) &&
                !child.labels.includes("ggjira-superseded")
              )
                targets.push(child);
            }
            if (targets.length !== taskIds.length) continue;
          } else targets.push(parent);
          recordPlanDeployment(db, {
            issueKey: parent.key,
            planReviewId: review.id,
            planVersion: review.planVersion,
            approvalId: request.id,
            taskIds,
            state: "active",
            now: this.deps.now(),
          });
          for (const target of targets) {
            const existing = db
              .prepare("SELECT * FROM slack_approvals WHERE review_id=? AND issue_key=?")
              .get(review.id, target.key) as Row | undefined;
            if (existing?.status === "applied") continue;
            if (!target.assigneeAccountId || target.assigneeAccountId !== thread.owner) continue;
            const publication = db
              .prepare("SELECT status FROM slack_publications WHERE review_id=? AND issue_key=?")
              .get(review.id, target.key);
            const allowed =
              target.key === parent.key
                ? [
                    workspace.workflow.requestStatus,
                    workspace.workflow.planningInProgressStatus,
                    workspace.workflow.inProgressStatus,
                  ]
                : [publication?.status, workspace.workflow.inProgressStatus];
            if (!allowed.includes(target.statusName)) continue;
            const currentParent = await jira.getIssue(parent.key);
            if (
              currentParent.assigneeAccountId !== thread.owner ||
              planningFingerprint(currentParent) !== request.input_hash ||
              latestPlanningRequest(db, parent.key)?.id !== request.id ||
              ![
                workspace.workflow.requestStatus,
                workspace.workflow.planningInProgressStatus,
                workspace.workflow.inProgressStatus,
              ].includes(currentParent.statusName)
            )
              break;
            const freshTarget = await jira.getIssue(target.key);
            if (
              freshTarget.assigneeAccountId !== thread.owner ||
              freshTarget.statusName !== target.statusName
            )
              continue;
            if (!existing)
              db.transaction(() => {
                db.prepare(
                  "INSERT OR IGNORE INTO slack_approvals(review_id,issue_key,owner,created_at) VALUES (?,?,?,?)",
                ).run(review.id, target.key, thread.owner ?? "", this.deps.now());
                appendAudit(db, {
                  at: this.deps.now(),
                  actor: "slack:auto",
                  action: "slack.implementation-approved",
                  subject: target.key,
                  detail: { planVersion: review.planVersion, requestId: request.id },
                });
              })();
            // Jira's transition helper is idempotent; a crash after the write is safe to resume.
            await jira.transitionIssueToStatus(target.key, workspace.workflow.inProgressStatus);
            db.prepare(
              "UPDATE slack_approvals SET status='applied' WHERE review_id=? AND issue_key=?",
            ).run(review.id, target.key);
            this.reconcileNeeded = true;
          }
        } catch {
          db.prepare("INSERT OR REPLACE INTO slack_errors VALUES (?,?)").run(
            `approve:${review.id}`,
            "자동 구현 승인 처리 실패: 다시 시도 중",
          );
        }
      }
    }
  }

  private async notifyJobs(): Promise<void> {
    const { db, jira } = this.deps;
    for (const thread of db
      .prepare("SELECT * FROM slack_threads WHERE thread_ts IS NOT NULL")
      .all() as Row[]) {
      if (!this.config.slack?.workspaceIds.includes(thread.workspace_id as string)) continue;
      db.prepare("DELETE FROM slack_errors WHERE id=?").run(`notify:${thread.id}`);
      try {
        const request = latestPlanningRequest(db, thread.issue_key as string);
        if (
          !request ||
          !db
            .prepare("SELECT 1 FROM slack_thread_requests WHERE request_id=? AND thread_id=?")
            .get(request.id, thread.id as string)
        )
          continue;
        const parent = await jira.getIssue(thread.issue_key as string);
        if (parent.assigneeAccountId !== thread.owner) continue;
        const keys = [
          parent.key,
          ...(await jira.searchIssues(`parent = "${parent.key}"`, { all: true })).map(
            (child) => child.key,
          ),
        ];
        for (const key of keys) {
          const job = db
            .prepare("SELECT * FROM jobs WHERE issue_key=? ORDER BY rowid DESC LIMIT 1")
            .get(key) as Row | undefined;
          if (!job || (job.created_at as string) < request.created_at) continue;
          const state = job.state as string;
          for (const attempt of db
            .prepare(
              "SELECT id FROM attempts WHERE job_id=? AND started_at IS NOT NULL ORDER BY rowid",
            )
            .all(job.id as string)) {
            this.enqueue(thread.id as string, `started:${thread.id}:${attempt.id}`, {
              text: `${key} · ${job.kind === "planning" ? "계획 시작" : job.kind === "integration_check" ? "통합 검증 시작" : "구현 시작"}`,
            });
          }
          const resultRow = db
            .prepare(
              "SELECT id,payload FROM results WHERE job_id=? AND applied=1 ORDER BY rowid DESC LIMIT 1",
            )
            .get(job.id as string);
          const result = resultRow
            ? (JSON.parse(resultRow.payload as string) as {
                status: string;
                implementation?: { decision?: DecisionRequest };
              })
            : undefined;
          if (
            job.kind === "implementation" &&
            result?.status === "needs_decision" &&
            result.implementation?.decision
          ) {
            const current = latestPlanningRequest(db, key) ?? request;
            if (!current) continue;
            const child = await jira.getIssue(key);
            if (child.assigneeAccountId !== thread.owner) continue;
            if (
              !db
                .prepare(
                  "SELECT 1 FROM report_steps WHERE result_id=? AND kind='comment' AND status='applied'",
                )
                .get(resultRow?.id as string)
            )
              continue;
            const qid = id(`${resultRow?.id}:${thread.id}`);
            const question = result.implementation.decision;
            db.prepare(
              "INSERT OR IGNORE INTO slack_questions(id,thread_id,request_id,source_id,issue_key,input_hash,kind,job_id,plan_version,options) VALUES (?,?,?,?,?,?,'implementation',?,?,?)",
            ).run(
              qid,
              thread.id as string,
              current.id,
              resultRow?.id as string,
              key,
              planningFingerprint(child),
              job.id as string,
              `implementation:${job.current_attempt_id}`,
              JSON.stringify(question.options),
            );
            this.enqueue(thread.id as string, `question:${qid}`, {
              text: `${key} · 구현 중 결정 필요\n${this.questionText(question)}`,
              blocks: this.questionBlocks(qid, question),
            });
            continue;
          }
          const label = (
            {
              running: "구현 시작",
              succeeded: "검토 대기",
              failed: "실패·확인 필요",
              timed_out: "실행 시간 초과",
              recovery_required: "실행 중단·복구 확인 필요",
              cancelled: "작업 취소",
            } as Record<string, string>
          )[state];
          if (!label) continue;
          if (state === "running" || (job.kind === "planning" && state === "succeeded")) continue;
          this.enqueue(
            thread.id as string,
            `job:${thread.id}:${job.id}:${job.current_attempt_id}:${state}`,
            {
              text: `${key} · ${job.kind === "planning" ? "계획" : job.kind === "integration_check" ? "통합 검증" : "구현"} · ${label}`,
            },
          );
        }
      } catch {
        db.prepare("INSERT OR REPLACE INTO slack_errors VALUES (?,?)").run(
          `notify:${thread.id}`,
          "Jira 작업 상태 확인 실패: 다시 시도 중",
        );
      }
    }
  }
}
