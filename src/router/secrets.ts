import { z } from "zod";

/**
 * Jira token, webhook secret, and admin API token all live in the Router
 * process's environment, never in the config file (docs/router-service-implementation-plan.md
 * §3 "Jira token·웹훅 secret·관리자 token은 Router 환경변수").
 */
const RouterEnvSecretsSchema = z.object({
  jiraEmail: z.string().email(),
  jiraApiToken: z.string().min(1),
  /** Signs/verifies `X-Hub-Signature` on incoming Jira webhooks (SHA-256 only). */
  webhookSecret: z.string().min(16),
  /** Bearer token the `ggjira router *` admin CLI authenticates with. */
  adminToken: z.string().min(16),
});
export type RouterEnvSecrets = z.infer<typeof RouterEnvSecretsSchema>;

export class RouterSecretsError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RouterSecretsError";
  }
}

export function loadRouterSecretsFromEnv(env: NodeJS.ProcessEnv = process.env): RouterEnvSecrets {
  const result = RouterEnvSecretsSchema.safeParse({
    jiraEmail: env.JIRA_EMAIL,
    jiraApiToken: env.JIRA_API_TOKEN,
    webhookSecret: env.GGJIRA_WEBHOOK_SECRET,
    adminToken: env.GGJIRA_ADMIN_TOKEN,
  });
  if (!result.success) {
    throw new RouterSecretsError(
      `Missing or invalid Router credentials in environment: ${result.error.message}`,
      result.error,
    );
  }
  return result.data;
}
