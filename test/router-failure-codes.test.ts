import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RouterConfigSchema } from "../src/router/config.js";
import type { JobRow } from "../src/router/db/jobs.js";
import {
  FAILURE_CODES,
  type FailureMatch,
  failureMessage,
  matchFailure,
} from "../src/router/failure-codes.js";
import { buildRecoveredSteps } from "../src/router/report-journal.js";
import { buildRouterConfig } from "./helpers/router-fixtures.js";

const code = (reason: string) => matchFailure(reason).code;
const ko = (reason: string) => failureMessage(matchFailure(reason), "ko");

/** Failure codes and their messages (ADR 0048). */
describe("failure codes", () => {
  it("has one entry per code, each with Korean and English text", () => {
    const codes = FAILURE_CODES.map((entry) => entry.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const entry of FAILURE_CODES) {
      expect(entry.message.ko).toMatch(/\S/);
      expect(entry.message.en).toMatch(/\S/);
      // Both languages fill the same placeholders.
      const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(names(entry.message.ko)).toEqual(names(entry.message.en));
    }
  });

  it("is documented: the runbook lists every code", () => {
    const runbook = readFileSync(new URL("../docs/runbook.md", import.meta.url), "utf-8");
    for (const entry of FAILURE_CODES) expect(runbook).toContain(`| \`${entry.code}\``);
  });

  it("codes the usual worker-reported failures", () => {
    expect(matchFailure("Failed to spawn worker: spawn codex ENOENT")).toEqual({
      code: "GGJ-101",
      params: { command: "codex" },
    });
    expect(
      code(
        "Worker exited with code 1: The 'sonnet' model is not supported when using Codex with a ChatGPT account.\nrmcp::transport::worker: worker quit",
      ),
    ).toBe("GGJ-201");
    expect(code("Worker exited with code 1: You've hit your usage limit.")).toBe("GGJ-202");
    expect(code("Worker exited with code 1: Not logged in · Please run /login")).toBe("GGJ-203");
    expect(code("Worker exited with code 1: stream disconnected")).toBe("GGJ-204");
    expect(code("Worker exited with code 1. Reading additional input from stdin...")).toBe(
      "GGJ-205",
    );
    expect(code("Validation command failed: npm test exited 1")).toBe("GGJ-301");
    expect(code("Verification failed: The change works")).toBe("GGJ-302");
    expect(code("The agent reported completion without any verification evidence.")).toBe(
      "GGJ-303",
    );
    expect(code("worker restarted mid-run")).toBe("GGJ-102");
    expect(matchFailure('unknown repositoryId "repo9"')).toEqual({
      code: "GGJ-103",
      params: { field: "repositoryId", value: "repo9" },
    });
    expect(code("could not create worktree at C:/x")).toBe("GGJ-104");
  });

  it("matches only the first line: later output does not decide the cause", () => {
    expect(code("Verification failed: The change works\nlogin page: 401")).toBe("GGJ-302");
    expect(code("Tests failed\nthe model was not found in cache")).toBe("GGJ-999");
  });

  it("shows Korean messages, with the parameters filled in", () => {
    expect(ko("Failed to spawn worker: spawn codex ENOENT")).toBe(
      '워커가 "codex"을(를) 실행하지 못했습니다. 설치돼 있지 않거나 워커의 PATH에 없습니다.',
    );
    expect(ko("Worker exited with code 1. Reading additional input from stdin...")).toBe(
      "AI CLI가 종료 코드 1(으)로 끝났습니다.",
    );
    expect(ko("Verification failed: The change works.")).toBe(
      "완료 조건 검증에 실패했습니다: The change works.",
    );
    expect(ko("Tests failed: 3 of 120")).toBe("분류되지 않은 오류: Tests failed: 3 of 120.");
    expect(ko("\n\n")).toBe("분류되지 않은 오류: no reason was reported.");
    const plan: FailureMatch = { code: "GGJ-401", params: { detail: "Plan has 12 tasks" } };
    expect(failureMessage(plan, "ko")).toBe("계획을 적용할 수 없습니다: Plan has 12 tasks.");
    expect(failureMessage(plan, "en")).toBe("The plan could not be applied: Plan has 12 tasks.");
  });

  it("clips a long detail", () => {
    const message = failureMessage(matchFailure(`x${"y".repeat(400)}`), "en");
    expect(message.length).toBeLessThan(240);
    expect(message).toMatch(/…\.$/);
  });

  it("shows Korean unless reporting.language says otherwise", () => {
    const raw = buildRouterConfig() as unknown as Record<string, unknown>;
    const parsed = RouterConfigSchema.parse({ ...raw, reporting: {} });
    expect(parsed.reporting.language).toBe("ko");

    const job = { id: "job-1", issueKey: "KAN-1", approvalId: "a-1" } as JobRow;
    const late = { status: "succeeded", summary: "done" };
    const comment = (language: "ko" | "en") => {
      const config = buildRouterConfig({
        reporting: { failureLabel: "ggjira-failed", language },
      });
      const steps = buildRecoveredSteps(config, job, "att-1", late);
      return String(steps.find((step) => step.kind === "comment")?.params.body);
    };
    expect(comment("ko")).toMatch(
      /^AI 실행이 GGJIRA Router와 연결이 끊겼습니다\.\n\[GGJ-501\] 결과가 너무 늦게 도착해 반영하지 않았습니다\(워커 보고: succeeded\)\./,
    );
    expect(comment("en")).toMatch(
      /^AI execution lost contact with GGJIRA Router\.\n\[GGJ-501\] Its result arrived too late to apply \(worker said: succeeded\)\.\nNext: .*\nDetails: .*KAN-1-att-1\.log on the Router machine\./,
    );
  });
});
