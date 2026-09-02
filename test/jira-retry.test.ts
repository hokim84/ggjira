import { describe, expect, it, vi } from "vitest";
import { withRetry } from "../src/jira/retry.js";

describe("withRetry", () => {
  it("returns the result on the first success without sleeping", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn, { sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a retryable failure and succeeds on a later attempt", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, { sleep, attempts: 5, baseDelayMs: 100 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("gives up and throws after exhausting attempts", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error("still failing"));

    await expect(withRetry(fn, { sleep, attempts: 3 })).rejects.toThrow("still failing");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not retry an error isRetryable rejects", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(new Error("permanent"));

    await expect(withRetry(fn, { sleep, attempts: 5, isRetryable: () => false })).rejects.toThrow(
      "permanent",
    );
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses getDelayMs's value instead of exponential backoff when it returns one", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce(new Error("rate limited")).mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      sleep,
      baseDelayMs: 100,
      getDelayMs: () => 5000,
    });

    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("falls back to exponential backoff when getDelayMs returns undefined", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValueOnce(new Error("transient")).mockResolvedValueOnce("ok");

    await withRetry(fn, { sleep, baseDelayMs: 100, getDelayMs: () => undefined });

    expect(sleep).toHaveBeenCalledWith(100);
  });
});
