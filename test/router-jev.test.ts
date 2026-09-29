import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ASSESSMENT_QUESTIONS, assessPendingJobs } from "../src/router/assessment.js";
import { getAssessment, listAssessments } from "../src/router/db/assessments.js";
import { getOpenJobForIssue } from "../src/router/db/jobs.js";
import { JevClient, JevError } from "../src/router/jev.js";
import { RouterHarness } from "./helpers/router-harness.js";

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { state: Record<string, string>; model: string; questions: Record<string, unknown> };
}

function jevAnswer(tier = "small", readiness = "ready") {
  return {
    model: "jev-1.13.0",
    answers: {
      modelTier: {
        type: "choice",
        choice: tier,
        probabilities: { small: 0.8, standard: 0.15, large: 0.05 },
        confidence: 0.7,
      },
      readiness: {
        type: "choice",
        choice: readiness,
        probabilities: { ready: 0.9, needs_plan: 0.05, unclear: 0.05 },
        confidence: 0.85,
      },
    },
    usage: { input_tokens: 812, output_tokens: 0 },
  };
}

/** A fetch stand-in answering from a queue of (status, body) pairs and recording each call. */
function fakeFetch(responses: Array<[number, unknown]>) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const [status, body] = responses.shift() ?? [500, { error: "no more responses" }];
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, calls };
}

const noSleep = async () => {};

describe("JevClient (ADR 0030)", () => {
  it("posts state and questions with the bearer key and parses the answers", async () => {
    const { fetch, calls } = fakeFetch([[200, jevAnswer()]]);
    const client = new JevClient({ apiKey: "test-key", fetch });

    const answer = await client.systemOne({ summary: "x" }, ASSESSMENT_QUESTIONS);

    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
    expect(calls[0]?.body).toMatchObject({ model: "jev-latest", state: { summary: "x" } });
    expect(Object.keys(calls[0]?.body.questions ?? {})).toEqual(["modelTier", "readiness"]);
    expect(answer.answers.modelTier).toMatchObject({ choice: "small", confidence: 0.7 });
    expect(answer.usage.input_tokens).toBe(812);
  });

  it("retries 429 and 529 with backoff, then gives up", async () => {
    const retried = fakeFetch([
      [429, "slow down"],
      [529, "overloaded"],
      [200, jevAnswer()],
    ]);
    await new JevClient({ apiKey: "k", fetch: retried.fetch, sleep: noSleep }).systemOne(
      {},
      ASSESSMENT_QUESTIONS,
    );
    expect(retried.calls).toHaveLength(3);

    const exhausted = fakeFetch([
      [429, "a"],
      [429, "b"],
      [429, "c"],
    ]);
    await expect(
      new JevClient({ apiKey: "k", fetch: exhausted.fetch, sleep: noSleep }).systemOne(
        {},
        ASSESSMENT_QUESTIONS,
      ),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("does not retry other errors and rejects answers of the wrong shape", async () => {
    const unauthorized = fakeFetch([[401, { error: "invalid key" }]]);
    await expect(
      new JevClient({ apiKey: "k", fetch: unauthorized.fetch }).systemOne({}, {}),
    ).rejects.toMatchObject({ status: 401 });
    expect(unauthorized.calls).toHaveLength(1);

    const garbled = fakeFetch([[200, { answers: "nope" }]]);
    await expect(
      new JevClient({ apiKey: "k", fetch: garbled.fetch }).systemOne({}, {}),
    ).rejects.toBeInstanceOf(JevError);
  });

  it("turns a timeout into a JevError", async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    await expect(
      new JevClient({ apiKey: "k", fetch: hanging, timeoutMs: 20 }).systemOne({}, {}),
    ).rejects.toThrow(/did not answer within 20ms/);
  });
});

describe("assessPendingJobs (shadow mode, ADR 0030)", () => {
  let router: RouterHarness;

  beforeEach(() => {
    router = new RouterHarness();
  });

  afterEach(async () => {
    await router.close();
  });

  it("records Jev's answers for a new job without changing the job", async () => {
    await router.seedQueuedJob();
    const job = getOpenJobForIssue(router.db, "KAN-1");
    const { fetch, calls } = fakeFetch([[200, jevAnswer("large", "needs_plan")]]);
    const jev = new JevClient({ apiKey: "k", fetch });

    const report = await assessPendingJobs({ db: router.db, jev, now: router.clock.now });

    expect(report.assessed).toEqual([job?.id]);
    expect(calls[0]?.body.state).toMatchObject({
      jobKind: "implementation",
      summary: "Implement KAN-1",
    });
    const assessment = getAssessment(router.db, job?.id ?? "");
    expect(assessment?.answers?.modelTier).toMatchObject({ choice: "large" });
    expect(assessment?.answers?.readiness).toMatchObject({ choice: "needs_plan" });
    expect(assessment?.inputTokens).toBe(812);
    expect(getOpenJobForIssue(router.db, "KAN-1")?.state).toBe("queued");

    // Already assessed: nothing more to ask.
    expect(
      (await assessPendingJobs({ db: router.db, jev, now: router.clock.now })).assessed,
    ).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(listAssessments(router.db, 10)).toHaveLength(1);
  });

  it("records failures and stops retrying after three tries", async () => {
    await router.seedQueuedJob();
    const jobId = getOpenJobForIssue(router.db, "KAN-1")?.id ?? "";
    const { fetch, calls } = fakeFetch([
      [401, "bad key"],
      [401, "bad key"],
      [401, "bad key"],
    ]);
    const jev = new JevClient({ apiKey: "k", fetch });

    for (let i = 0; i < 4; i++) {
      await assessPendingJobs({ db: router.db, jev, now: router.clock.now });
    }

    expect(calls).toHaveLength(3);
    expect(getAssessment(router.db, jobId)).toMatchObject({ tries: 3, answers: null });
    expect(getAssessment(router.db, jobId)?.error).toMatch(/401/);
  });

  it("does not back-fill jobs older than a day", async () => {
    await router.seedQueuedJob();
    router.clock.advance(25 * 60 * 60 * 1000);
    const { fetch, calls } = fakeFetch([]);
    await assessPendingJobs({
      db: router.db,
      jev: new JevClient({ apiKey: "k", fetch }),
      now: router.clock.now,
    });
    expect(calls).toHaveLength(0);
  });
});
