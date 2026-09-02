import type { AppConfig } from "../config.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import type { Job } from "../job/job.js";

export function buildStartComment(runId: string): string {
  return ["GGJIRA가 이 작업을 시작합니다.", `runId: ${runId}`].join("\n");
}

export function buildSuccessComment(
  job: Job,
  changedFiles: string[],
  workerLogPath: string,
): string {
  const fileList =
    changedFiles.length > 0
      ? changedFiles.map((f) => `  - ${f}`).join("\n")
      : "  (변경된 파일 없음)";
  return [
    "GGJIRA 작업이 완료되었습니다.",
    "",
    `요약: ${job.summary ?? "(요약 없음)"}`,
    `브랜치: ${job.branch ?? "(없음)"}`,
    `변경 파일 (${changedFiles.length}개):`,
    fileList,
    "",
    `runId: ${job.runId}`,
    `실행 로그: ${workerLogPath}`,
  ].join("\n");
}

export function buildFailureComment(job: Job): string {
  return [
    `GGJIRA 작업이 실패했습니다 (${job.status}).`,
    "",
    `원인: ${job.error ?? "(알 수 없음)"}`,
    `실패 단계: ${job.failureStage ?? "(알 수 없음)"}`,
    `runId: ${job.runId}`,
  ].join("\n");
}

export async function claimIssueInJira(
  jira: JiraGateway,
  config: AppConfig,
  issue: JiraIssue,
  runId: string,
): Promise<void> {
  await jira.transitionIssue(issue.key, config.jira.inProgressTransitionName);
  await jira.addComment(issue.key, buildStartComment(runId));
}

export async function reportSuccess(
  jira: JiraGateway,
  config: AppConfig,
  issue: JiraIssue,
  job: Job,
  changedFiles: string[],
  workerLogPath: string,
): Promise<void> {
  await jira.addComment(issue.key, buildSuccessComment(job, changedFiles, workerLogPath));
  await jira.transitionIssue(issue.key, config.jira.successTransitionName);
}

export async function reportFailure(
  jira: JiraGateway,
  config: AppConfig,
  issue: JiraIssue,
  job: Job,
): Promise<void> {
  await jira.addComment(issue.key, buildFailureComment(job));
  await jira.addLabel(issue.key, config.jira.failureLabel);
}
