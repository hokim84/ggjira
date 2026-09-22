import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadWorkerCredential, WorkerCredentialError } from "../src/worker-runtime/credential.js";

describe("loadWorkerCredential", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "ggjira-worker-credential-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("loads a valid credential file", () => {
    const credentialPath = path.join(dataDir, "credential.json");
    writeFileSync(credentialPath, JSON.stringify({ workerId: "worker-a", workerToken: "secret" }));

    expect(loadWorkerCredential(credentialPath)).toEqual({
      workerId: "worker-a",
      workerToken: "secret",
    });
  });

  it("throws WorkerCredentialError with a 'run setup' hint for a missing file", () => {
    expect(() => loadWorkerCredential(path.join(dataDir, "does-not-exist.json"))).toThrow(
      /ggjira worker setup/,
    );
  });

  it("throws WorkerCredentialError for invalid JSON", () => {
    const credentialPath = path.join(dataDir, "credential.json");
    writeFileSync(credentialPath, "{ not json");
    expect(() => loadWorkerCredential(credentialPath)).toThrow(WorkerCredentialError);
  });

  it("throws WorkerCredentialError when workerToken is missing", () => {
    const credentialPath = path.join(dataDir, "credential.json");
    writeFileSync(credentialPath, JSON.stringify({ workerId: "worker-a" }));
    expect(() => loadWorkerCredential(credentialPath)).toThrow(WorkerCredentialError);
  });
});
