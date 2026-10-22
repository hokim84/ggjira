import type { JobResult } from "../contracts/envelope.js";
import type { JobKind } from "../contracts/protocol.js";

export type ExecutionStage =
  | "preparing"
  | "agent"
  | "validating"
  | "committing"
  | "pushing"
  | "checking_target";
export interface WorkerProgress {
  at: number;
  state:
    | "connecting"
    | "waiting"
    | "started"
    | "progress"
    | "reporting"
    | "finished"
    | "cancelling"
    | "reconnecting"
    | "resent";
  issueKey?: string;
  kind?: JobKind;
  stage?: ExecutionStage;
  elapsedMs?: number;
  resultStatus?: JobResult["status"];
  delivered?: boolean;
  count?: number;
  verificationPassed?: boolean;
}

const KIND: Record<JobKind, string> = {
  planning: "계획",
  implementation: "구현",
  quality_review: "품질 평가",
  integration_check: "통합 검증",
};
const STAGE: Record<ExecutionStage, string> = {
  preparing: "작업 환경 준비 중",
  agent: "AI 실행 중",
  validating: "검증 중",
  committing: "커밋 중",
  pushing: "결과 업로드 중",
  checking_target: "통합 커밋 확인 중",
};
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

/** A bounded line, without model output, prompts, credentials or invented percentages. */
export function formatWorkerProgress(event: WorkerProgress): string {
  const date = new Date(event.at);
  const time = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
  const issue = event.issueKey
    ? `${event.issueKey.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80)} `
    : "";
  const kind = event.kind ? KIND[event.kind] : "작업";
  let text: string;
  switch (event.state) {
    case "connecting":
      text = "Router 연결 중";
      break;
    case "waiting":
      text = "작업 대기 중";
      break;
    case "reconnecting":
      text = "Router 연결 재시도 중";
      break;
    case "started":
      text = `${kind} 시작`;
      break;
    case "progress":
      text = STAGE[event.stage ?? "preparing"];
      break;
    case "reporting":
      text = "결과 전송 중";
      break;
    case "cancelling":
      text = "작업 중단 요청됨";
      break;
    case "resent":
      text = `보관 결과 ${event.count ?? 0}건 전송 완료`;
      break;
    case "finished": {
      text =
        event.resultStatus === "planned"
          ? "계획 작성 완료"
          : event.resultStatus === "needs_decision"
            ? "사람의 판단 필요"
            : event.resultStatus === "cancelled"
              ? "작업 중단"
              : event.resultStatus === "failed"
                ? `${kind} 실패`
                : event.kind === "quality_review" && event.verificationPassed === false
                  ? "평가 완료 · 검증 미통과"
                  : `${kind} 완료`;
      text += event.delivered ? " · Router 전송 완료" : " · 결과 보관됨, Router 전송 미완료";
      break;
    }
  }
  return `[${time}] ${issue}${text}${event.elapsedMs !== undefined ? ` (${elapsed(event.elapsedMs)})` : ""}`;
}
