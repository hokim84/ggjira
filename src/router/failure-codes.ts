/**
 * Failure codes and the text a failure comment shows for each (ADR 0048). Pure.
 *
 * A worker reports a failure as free text; `matchFailure` gives it a code by matching the table's
 * patterns, in table order, against its first line only. Workers put the cause there (the CLI's
 * own error, the check that failed), and later output mentions words like "login" or "model" for
 * other reasons. Failures Router finds itself (a timeout, a plan it cannot apply) are given their
 * code directly. Anything unmatched is `GGJ-999`, shown with its first line.
 *
 * Messages are full sentences; `{name}` is filled from the pattern's named groups (or the params
 * Router passes). docs/runbook.md lists every code with what to do about it.
 */

import type { MessageLanguage } from "./comment-text.js";

export type FailureCode =
  | "GGJ-101"
  | "GGJ-102"
  | "GGJ-103"
  | "GGJ-104"
  | "GGJ-105"
  | "GGJ-201"
  | "GGJ-202"
  | "GGJ-203"
  | "GGJ-204"
  | "GGJ-205"
  | "GGJ-301"
  | "GGJ-302"
  | "GGJ-303"
  | "GGJ-401"
  | "GGJ-402"
  | "GGJ-403"
  | "GGJ-501"
  | "GGJ-999";

export interface FailureDefinition {
  code: FailureCode;
  /** Matched against the first line of a worker-reported reason. Absent for codes Router gives. */
  pattern?: RegExp;
  message: Record<MessageLanguage, string>;
}

/** Matched in this order: the specific causes before the generic "the CLI exited". */
export const FAILURE_CODES: readonly FailureDefinition[] = [
  {
    code: "GGJ-101",
    pattern: /spawn (?<command>\S+) (?:ENOENT|EFTYPE|EACCES)/,
    message: {
      ko: '워커가 "{command}"을(를) 실행하지 못했습니다. 설치돼 있지 않거나 워커의 PATH에 없습니다.',
      en: 'The worker could not start "{command}": it is not installed or not on the worker\'s PATH.',
    },
  },
  {
    code: "GGJ-201",
    pattern: /model.*(?:not supported|not found|does not exist|not available|invalid)/i,
    message: {
      ko: "AI CLI가 모델을 거부했습니다. 워커 설정의 provider 모델을 확인하세요.",
      en: "The AI CLI rejected the model; check the worker's provider model.",
    },
  },
  {
    code: "GGJ-202",
    pattern: /usage limit|rate limit|quota|too many requests|\b429\b/i,
    message: {
      ko: "AI 계정의 사용량 한도에 도달했습니다. 한도가 초기화된 뒤 다시 요청하세요.",
      en: "The AI account reached its usage limit; request it again after the limit resets.",
    },
  },
  {
    code: "GGJ-203",
    pattern:
      /not logged in|log ?in required|please (?:log|sign) in|unauthori[sz]ed|\b401\b|invalid api key|authentication/i,
    message: {
      ko: "워커의 AI CLI가 로그인돼 있지 않거나 로그인이 거부됐습니다.",
      en: "The AI CLI is not logged in on the worker, or its login was rejected.",
    },
  },
  {
    code: "GGJ-301",
    pattern: /^Validation command failed/,
    message: {
      ko: "워커의 검증 명령이 실패했습니다.",
      en: "The worker's validation command failed.",
    },
  },
  {
    code: "GGJ-302",
    pattern: /^Verification failed: (?<detail>.+)/,
    message: {
      ko: "완료 조건 검증에 실패했습니다: {detail}.",
      en: "Verification failed: {detail}.",
    },
  },
  {
    code: "GGJ-303",
    pattern: /^The agent reported completion without any verification evidence/,
    message: {
      ko: "AI가 검증 근거 없이 완료를 보고했습니다.",
      en: "The agent reported completion without any verification evidence.",
    },
  },
  {
    code: "GGJ-102",
    pattern: /^worker restarted mid-run/,
    message: {
      ko: "실행 중에 워커가 다시 시작됐습니다.",
      en: "The worker restarted while the run was in progress.",
    },
  },
  {
    code: "GGJ-103",
    pattern: /^unknown (?<field>repositoryId|providerId) "(?<value>[^"]+)"/,
    message: {
      ko: '워커에 {field} "{value}"이(가) 설정돼 있지 않습니다.',
      en: 'The worker has no {field} "{value}" configured.',
    },
  },
  {
    code: "GGJ-104",
    pattern: /worktree/i,
    message: {
      ko: "워커가 실행용 git worktree를 준비하지 못했습니다.",
      en: "The worker could not prepare a git worktree for the run.",
    },
  },
  {
    code: "GGJ-204",
    pattern: /^Worker exited with code (?:-?\d+|null):\s*(?<detail>.+)/,
    message: {
      ko: "AI CLI가 실패했습니다: {detail}.",
      en: "The AI CLI failed: {detail}.",
    },
  },
  {
    code: "GGJ-205",
    pattern: /^Worker exited with code (?<exitCode>-?\d+|null)/,
    message: {
      ko: "AI CLI가 종료 코드 {exitCode}(으)로 끝났습니다.",
      en: "The AI CLI exited with code {exitCode}.",
    },
  },
  {
    code: "GGJ-105",
    message: {
      ko: "제한 시간 안에 끝나지 않았습니다.",
      en: "The run took longer than its time limit.",
    },
  },
  {
    code: "GGJ-401",
    message: {
      ko: "계획을 적용할 수 없습니다: {detail}.",
      en: "The plan could not be applied: {detail}.",
    },
  },
  {
    code: "GGJ-402",
    message: {
      ko: "계획 결과에 계획이 없습니다.",
      en: "The planning result carried no plan.",
    },
  },
  {
    code: "GGJ-403",
    message: {
      ko: "결정이 필요하다고 보고했지만 결정 내용이 없습니다.",
      en: "The result asked for a decision but carried none.",
    },
  },
  {
    code: "GGJ-501",
    message: {
      ko: "결과가 너무 늦게 도착해 반영하지 않았습니다(워커 보고: {status}).",
      en: "Its result arrived too late to apply (worker said: {status}).",
    },
  },
  {
    code: "GGJ-999",
    message: {
      ko: "분류되지 않은 오류: {detail}.",
      en: "Unclassified failure: {detail}.",
    },
  },
];

const BY_CODE = new Map(FAILURE_CODES.map((entry) => [entry.code, entry]));

const MAX_PARAM_LENGTH = 200;

export interface FailureMatch {
  code: FailureCode;
  params: Record<string, string>;
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** The code of a worker-reported failure reason. */
export function matchFailure(reason: string | undefined): FailureMatch {
  const line = firstLine(reason ?? "");
  if (!line) return { code: "GGJ-999", params: { detail: "no reason was reported" } };
  for (const entry of FAILURE_CODES) {
    const match = entry.pattern ? line.match(entry.pattern) : null;
    if (match) return { code: entry.code, params: { ...match.groups } };
  }
  return { code: "GGJ-999", params: { detail: line } };
}

function clip(text: string): string {
  const trimmed = text.trim().replace(/[.\s]+$/, "");
  return trimmed.length > MAX_PARAM_LENGTH ? `${trimmed.slice(0, MAX_PARAM_LENGTH - 1)}…` : trimmed;
}

/** The sentence a failure comment shows for `match`, in `language`. */
export function failureMessage(match: FailureMatch, language: MessageLanguage): string {
  const entry = BY_CODE.get(match.code) ?? (BY_CODE.get("GGJ-999") as FailureDefinition);
  return entry.message[language].replace(/\{(\w+)\}/g, (_, name: string) =>
    clip(match.params[name] ?? "?"),
  );
}
