import { existsSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { JiraGateway } from "../jira/gateway.js";
import {
  randomSecret,
  readRawRouterConfig,
  routerConfigTemplate,
  validateRouterConfig,
  writeRouterConfig,
  writeRouterSecretsFile,
} from "./config-store.js";
import { loadRouterSecretsFromEnv, RouterSecretsError, SECRET_ENV_KEYS } from "./secrets.js";
import { bearerToken, tokensEqual } from "./server.js";
import { registerWebUi } from "./web-ui.js";

/**
 * `router serve` without a config or secrets: a Fastify app with only the web UI and the setup
 * wizard API (ADR 0023). No database, no Jira loops. Every `/api/v1/setup/*` call needs the
 * one-time setup token printed on the console; it stops working once setup completes.
 */

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export interface SetupServerDeps {
  configPath: string;
  secretsPath: string;
  setupToken: string;
  jiraFactory: (credentials: JiraCredentials) => JiraGateway;
  webUiRoot?: string;
}

export interface SetupCompleteResponse {
  configPath: string;
  secretsPath: string;
  adminToken: string;
  webhookSecret: string;
  webhookPath: string;
}

const CredentialsSchema = z.object({
  baseUrl: z.string().url(),
  email: z.string().min(1),
  apiToken: z.string().min(1),
});

const StatusesRequestSchema = CredentialsSchema.extend({ projectKey: z.string().min(1) });

const CompleteRequestSchema = z.object({
  config: z.unknown(),
  jiraEmail: z.string().min(1),
  jiraApiToken: z.string().min(1),
});

class SetupError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new SetupError(
      400,
      "invalid_request",
      "request body is invalid",
      result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return result.data;
}

async function callJira<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw new SetupError(502, "jira_error", error instanceof Error ? error.message : String(error));
  }
}

export function buildSetupServer(deps: SetupServerDeps): FastifyInstance {
  const app = Fastify();
  let completed = false;

  app.get("/health", async () => ({ status: "ok", mode: "setup" }));
  registerWebUi(app, deps.webUiRoot);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SetupError) {
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
        ...(error.issues ? { issues: error.issues } : {}),
      });
    }
    const { statusCode: status, message } = error as { statusCode?: number; message?: string };
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: "invalid_request", message });
    }
    return reply.code(500).send({ error: "internal_error" });
  });

  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request: FastifyRequest, reply) => {
        if (completed) {
          return reply
            .code(410)
            .send({ error: "setup_complete", message: "setup is done; restart the Router" });
        }
        if (!tokensEqual(bearerToken(request), deps.setupToken)) {
          return reply
            .code(401)
            .send({ error: "unauthenticated", message: "setup token required" });
        }
      });

      scope.get("/state", async () => {
        let existingConfig: unknown = null;
        if (existsSync(deps.configPath)) {
          try {
            existingConfig = readRawRouterConfig(deps.configPath);
          } catch {
            existingConfig = null;
          }
        }
        return {
          configPath: deps.configPath,
          secretsPath: deps.secretsPath,
          existingConfig,
          template: routerConfigTemplate(),
        };
      });

      scope.post("/jira/test", async (request) => {
        const credentials = parse(CredentialsSchema, request.body);
        const me = await callJira(() => deps.jiraFactory(credentials).getMyself());
        return { displayName: me.displayName, accountId: me.accountId };
      });

      scope.post("/jira/projects", async (request) => {
        const credentials = parse(CredentialsSchema, request.body);
        return { projects: await callJira(() => deps.jiraFactory(credentials).listProjects()) };
      });

      scope.post("/jira/statuses", async (request) => {
        const { projectKey, ...credentials } = parse(StatusesRequestSchema, request.body);
        const statuses = await callJira(() =>
          deps.jiraFactory(credentials).listProjectStatuses(projectKey),
        );
        return { statuses };
      });

      scope.post("/complete", async (request): Promise<SetupCompleteResponse> => {
        const body = parse(CompleteRequestSchema, request.body);
        const validation = validateRouterConfig(body.config);
        if (!validation.ok) {
          throw new SetupError(400, "invalid_config", "config is invalid", validation.issues);
        }
        let secrets: ReturnType<typeof loadRouterSecretsFromEnv>;
        try {
          secrets = loadRouterSecretsFromEnv({
            [SECRET_ENV_KEYS.jiraEmail]: body.jiraEmail,
            [SECRET_ENV_KEYS.jiraApiToken]: body.jiraApiToken,
            [SECRET_ENV_KEYS.webhookSecret]: randomSecret(),
            [SECRET_ENV_KEYS.adminToken]: randomSecret(),
          });
        } catch (error) {
          if (error instanceof RouterSecretsError) {
            throw new SetupError(400, "invalid_secrets", error.message);
          }
          throw error;
        }
        writeRouterConfig(deps.configPath, body.config);
        writeRouterSecretsFile(deps.secretsPath, secrets);
        completed = true;
        return {
          configPath: deps.configPath,
          secretsPath: deps.secretsPath,
          adminToken: secrets.adminToken,
          webhookSecret: secrets.webhookSecret,
          webhookPath: "/webhooks/jira",
        };
      });
    },
    { prefix: "/api/v1/setup" },
  );

  return app;
}
