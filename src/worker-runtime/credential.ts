import { readFileSync } from "node:fs";
import { z } from "zod";

/** Issued once by `POST /api/v1/workers/register` and stored locally at
 *  `WorkerConfig.credentialPath` — never in the worker's main config file. */
const WorkerCredentialSchema = z.object({
  workerId: z.string().min(1),
  workerToken: z.string().min(1),
});
export type WorkerCredential = z.infer<typeof WorkerCredentialSchema>;

export class WorkerCredentialError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "WorkerCredentialError";
  }
}

export function loadWorkerCredential(credentialPath: string): WorkerCredential {
  let raw: string;
  try {
    raw = readFileSync(credentialPath, "utf-8");
  } catch (error) {
    throw new WorkerCredentialError(
      `Failed to read worker credential file at ${credentialPath}. Run "ggjira worker setup" (or "workers pair" on Router) first.`,
      error,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new WorkerCredentialError(
      `Worker credential file at ${credentialPath} is not valid JSON`,
      error,
    );
  }

  const result = WorkerCredentialSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkerCredentialError(
      `Worker credential file at ${credentialPath} failed validation: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
