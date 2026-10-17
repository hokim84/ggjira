import { describe, expect, it } from "vitest";
import {
  IMPLEMENTATION_REPORT_JSON_SCHEMA,
  ImplementationReportSchema,
} from "../src/contracts/implementation.js";
import { readImplementationReport } from "../src/worker-runtime/executor.js";
import { compareJsonSchema, type JsonNode } from "./helpers/json-schema-parity.js";

const decision = {
  question: "Add a column to the users table?",
  options: [
    { id: "a", title: "Add the column", pros: ["simple"], cons: ["migration"] },
    { id: "b", title: "Derive it at read time" },
  ],
  recommendation: "b",
  impact: "A migration is out of scope for this ticket.",
};

describe("IMPLEMENTATION_REPORT_JSON_SCHEMA (ADR 0036)", () => {
  it("mirrors ImplementationReportSchema at every level", () => {
    compareJsonSchema(
      ImplementationReportSchema,
      IMPLEMENTATION_REPORT_JSON_SCHEMA as unknown as JsonNode,
      "report",
    );
  });
});

describe("ImplementationReportSchema", () => {
  it("requires a decision when the outcome is needs_decision", () => {
    expect(
      ImplementationReportSchema.safeParse({ outcome: "needs_decision", summary: "stuck" }).success,
    ).toBe(false);
    expect(
      ImplementationReportSchema.safeParse({
        outcome: "needs_decision",
        summary: "stuck",
        decision,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown verification status", () => {
    const parsed = ImplementationReportSchema.safeParse({
      outcome: "completed",
      summary: "done",
      verification: [{ acceptance: "x", status: "probably", evidence: "" }],
    });
    expect(parsed.success).toBe(false);
  });
});

describe("readImplementationReport", () => {
  it("prefers structuredOutput", () => {
    const result = readImplementationReport({
      structuredOutput: { outcome: "completed", summary: "structured" },
      summary: '```json\n{"outcome":"completed","summary":"text"}\n```',
    });
    expect(result).toMatchObject({ ok: true, report: { summary: "structured" } });
  });

  it("falls back to a fenced JSON block in the final text (Codex)", () => {
    const result = readImplementationReport({
      summary: 'Done.\n```json\n{"outcome":"completed","summary":"from text"}\n```',
    });
    expect(result).toMatchObject({ ok: true, report: { summary: "from text" } });
  });

  it("fails on prose without JSON, malformed JSON, or the wrong shape", () => {
    expect(readImplementationReport({ summary: "All done!" }).ok).toBe(false);
    expect(readImplementationReport({ summary: '```json\n{"outcome": \n```' }).ok).toBe(false);
    expect(
      readImplementationReport({ structuredOutput: { summary: "no outcome" }, summary: "" }),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("schema") });
  });
});
