import { describe, expect, it } from "vitest";
import { JobResultSchema } from "../src/contracts/envelope.js";
import { PROTOCOL_VERSION } from "../src/contracts/protocol.js";
import {
  IMPLEMENTATION_REPORT_JSON_SCHEMA,
  ImplementationReportSchema,
} from "../src/contracts/implementation.js";
import { readImplementationReport } from "../src/worker-runtime/executor.js";
import { type JsonNode, compareJsonSchema } from "./helpers/json-schema-parity.js";

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

  it("keeps the check method, and reads a missing or unknown one as unreported (ADR 0059)", () => {
    const parse = (method: unknown) =>
      ImplementationReportSchema.parse({
        outcome: "completed",
        summary: "done",
        verification: [{ acceptance: "x", status: "pass", evidence: "npm test", method }],
      }).verification[0];
    expect(parse("executed")).toMatchObject({ method: "executed" });
    expect(parse("inspected")).toMatchObject({ method: "inspected" });
    expect(parse(undefined)?.method).toBeUndefined();
    // A made-up value does not discard the finished report; it is just not counted.
    expect(parse("static")).toEqual({ acceptance: "x", status: "pass", evidence: "npm test" });
  });
});

describe("results from a protocol-2 worker before M4 (T14)", () => {
  it("still parse: no git, no execution, no risks — read as unknown, never invented", () => {
    const parsed = JobResultSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      jobId: "job-1",
      attemptId: "attempt-1",
      resultId: "result-1",
      status: "succeeded",
      summary: "done",
      implementation: {
        outcome: "completed",
        summary: "done",
        scopeDeviations: [],
        verification: [{ acceptance: "x", status: "pass", evidence: "ok" }],
      },
    });
    expect(parsed.git).toBeUndefined();
    expect(parsed.execution).toBeUndefined();
    expect(parsed.implementation?.risks).toEqual([]);
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
