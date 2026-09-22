import { describe, expect, it } from "vitest";
import {
  ACTIVE_ATTEMPT_STATES,
  assertAttemptStateTransition,
  ATTEMPT_STATES,
  canTransitionAttemptState,
  InvalidAttemptStateTransitionError,
  isAttemptStateTerminal,
} from "../src/contracts/attempt-state.js";
import {
  ACTIVE_ATTEMPT_JOB_STATES,
  assertJobStateTransition,
  canTransitionJobState,
  InvalidJobStateTransitionError,
  isJobStateClosed,
  JOB_STATES,
} from "../src/contracts/job-state.js";

describe("job state machine", () => {
  it("allows every arrow in the documented diagram", () => {
    const allowed: [string, string][] = [
      ["waiting", "queued"],
      ["waiting", "cancelled"],
      ["queued", "leased"],
      ["queued", "cancelled"],
      ["leased", "running"],
      ["leased", "queued"],
      ["leased", "cancelled"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "timed_out"],
      ["running", "cancel_requested"],
      ["running", "recovery_required"],
      ["cancel_requested", "cancelled"],
      ["recovery_required", "cancelled"],
      ["recovery_required", "queued"],
      ["failed", "queued"],
      ["timed_out", "queued"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionJobState(from as never, to as never)).toBe(true);
      expect(() => assertJobStateTransition(from as never, to as never)).not.toThrow();
    }
  });

  it("rejects transitions that skip states or go backwards illegally", () => {
    expect(canTransitionJobState("waiting", "running")).toBe(false);
    expect(canTransitionJobState("queued", "running")).toBe(false);
    expect(canTransitionJobState("succeeded", "queued")).toBe(false);
    expect(() => assertJobStateTransition("waiting", "running")).toThrow(
      InvalidJobStateTransitionError,
    );
  });

  it("has no outgoing transitions from succeeded or cancelled", () => {
    expect(canTransitionJobState("succeeded", "queued")).toBe(false);
    expect(canTransitionJobState("cancelled", "queued")).toBe(false);
  });

  it("closes the one-non-terminal-job-per-issue slot only for succeeded/cancelled", () => {
    for (const state of JOB_STATES) {
      const expected = state === "succeeded" || state === "cancelled";
      expect(isJobStateClosed(state)).toBe(expected);
    }
  });

  it("marks leased/running/cancel_requested as occupying the one-active-attempt-per-worker slot", () => {
    expect([...ACTIVE_ATTEMPT_JOB_STATES].sort()).toEqual(
      ["cancel_requested", "leased", "running"].sort(),
    );
  });
});

describe("attempt state machine", () => {
  it("allows every arrow in the documented diagram", () => {
    const allowed: [string, string][] = [
      ["leased", "running"],
      ["leased", "cancelled"],
      ["leased", "recovery_required"],
      ["running", "succeeded"],
      ["running", "failed"],
      ["running", "timed_out"],
      ["running", "cancel_requested"],
      ["running", "recovery_required"],
      ["cancel_requested", "cancelled"],
      ["recovery_required", "cancelled"],
      ["recovery_required", "superseded"],
    ];
    for (const [from, to] of allowed) {
      expect(canTransitionAttemptState(from as never, to as never)).toBe(true);
      expect(() => assertAttemptStateTransition(from as never, to as never)).not.toThrow();
    }
  });

  it("rejects a retry-in-place: terminal states never transition again", () => {
    for (const state of ["succeeded", "failed", "timed_out", "cancelled", "superseded"] as const) {
      expect(canTransitionAttemptState(state, "leased")).toBe(false);
      expect(isAttemptStateTerminal(state)).toBe(true);
    }
  });

  it("throws InvalidAttemptStateTransitionError with the offending states attached", () => {
    expect(() => assertAttemptStateTransition("succeeded", "running")).toThrow(
      InvalidAttemptStateTransitionError,
    );
    try {
      assertAttemptStateTransition("succeeded", "running");
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAttemptStateTransitionError);
      expect((error as InvalidAttemptStateTransitionError).from).toBe("succeeded");
      expect((error as InvalidAttemptStateTransitionError).to).toBe("running");
    }
  });

  it("matches ACTIVE_ATTEMPT_STATES to the leased/running/cancel_requested trio", () => {
    expect([...ACTIVE_ATTEMPT_STATES].sort()).toEqual(
      ["cancel_requested", "leased", "running"].sort(),
    );
  });

  it("every listed attempt state is reachable in the transition table (no orphans)", () => {
    // Every non-initial state must be some other state's allowed target.
    const reachable = new Set<string>(["leased"]);
    for (const from of ATTEMPT_STATES) {
      for (const to of ATTEMPT_STATES) {
        if (canTransitionAttemptState(from, to)) reachable.add(to);
      }
    }
    expect([...reachable].sort()).toEqual([...ATTEMPT_STATES].sort());
  });
});
