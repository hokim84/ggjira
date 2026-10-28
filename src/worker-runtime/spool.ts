import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { type JobResult, JobResultSchema } from "../contracts/envelope.js";
import type { Logger } from "../logger.js";

const SUFFIX = ".json";
/** Results Router refused for good (403/404), kept for a person to look at; never resent. */
const REJECTED_DIR = "rejected";

/** `resultId` becomes a filename, so it must never be able to point outside the spool. */
function assertSafeId(resultId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(resultId) || resultId.startsWith(".")) {
    throw new Error(`Refusing to spool result with unsafe id "${resultId}"`);
  }
}

/**
 * Results waiting for Router's acknowledgement (docs/router-service-implementation-plan.md §3
 * "워커는 결과를 로컬에 원자적으로 저장한 후 전송한다. Router가 수신을 확인하기 전까지 보존하고
 * 재시작 후 재전송한다").
 *
 * Each result is one file, written to a temp name, fsynced, then renamed into place — so a crash
 * leaves either the complete previous state or the complete new file, never a torn one. Resending
 * is safe because Router treats an identical `resultId` resubmission as success.
 */
export class ResultSpool {
  constructor(
    readonly dir: string,
    private readonly logger?: Logger,
  ) {}

  save(result: JobResult): string {
    assertSafeId(result.resultId);
    mkdirSync(this.dir, { recursive: true });
    const finalPath = path.join(this.dir, `${result.resultId}${SUFFIX}`);
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    const fd = openSync(tempPath, "w");
    try {
      writeSync(fd, JSON.stringify(result));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, finalPath);
    return finalPath;
  }

  /** Spooled results, oldest file name first. Unreadable/corrupt files — including results an
   *  older protocol version wrote (ADR 0036) — are skipped with a warning and kept on disk for a
   *  human to look at, rather than blocking the resend of everything else. */
  listPending(): JobResult[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(SUFFIX))
      .sort()
      .flatMap((name) => {
        const file = path.join(this.dir, name);
        try {
          const parsed = JobResultSchema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
          if (parsed.success) return [parsed.data];
          this.logger?.warn(
            { layer: "worker-runtime", file, issues: parsed.error.issues.slice(0, 3) },
            "spooled result does not match this protocol version; left on disk, not resent",
          );
          return [];
        } catch (error) {
          this.logger?.warn(
            { layer: "worker-runtime", file, err: error },
            "spooled result is unreadable; left on disk, not resent",
          );
          return [];
        }
      });
  }

  hasPendingFor(attemptId: string): boolean {
    return this.listPending().some((result) => result.attemptId === attemptId);
  }

  /** Router acknowledged it: the spool no longer needs to keep it. */
  ack(resultId: string): void {
    assertSafeId(resultId);
    rmSync(path.join(this.dir, `${resultId}${SUFFIX}`), { force: true });
  }

  /** Router will never accept it (an attempt it does not know, or another worker's): keep the
   *  file for a person under `rejected/`, out of the resend list. Returns where it went. */
  reject(resultId: string): string {
    assertSafeId(resultId);
    const rejectedDir = path.join(this.dir, REJECTED_DIR);
    mkdirSync(rejectedDir, { recursive: true });
    const target = path.join(rejectedDir, `${resultId}${SUFFIX}`);
    const source = path.join(this.dir, `${resultId}${SUFFIX}`);
    if (existsSync(source)) renameSync(source, target);
    return target;
  }
}
