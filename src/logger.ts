import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const rootLogger = pino({
  level,
  base: null,
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof rootLogger;

export function childLogger(bindings: {
  layer: string;
  issueKey?: string;
  runId?: string;
  stage?: string;
}): Logger {
  return rootLogger.child(bindings) as Logger;
}
