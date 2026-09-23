import { parseArgs } from "node:util";

/** Output sink for CLI commands; tests capture it instead of writing to the console. */
export interface CliIo {
  out(line: string): void;
  err(line: string): void;
  env: NodeJS.ProcessEnv;
}

export const processIo: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
};

/** Thrown for a usage mistake; the CLI prints it and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

type OptionSpec = Record<string, { type: "string" | "boolean"; short?: string }>;

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | boolean | undefined>;
}

export function parseCommandArgs(args: string[], options: OptionSpec): ParsedArgs {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return {
      positionals: parsed.positionals,
      values: parsed.values as Record<string, string | boolean | undefined>,
    };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

export function stringOption(parsed: ParsedArgs, name: string): string | undefined {
  const value = parsed.values[name];
  return typeof value === "string" ? value : undefined;
}

export function requirePositional(parsed: ParsedArgs, index: number, what: string): string {
  const value = parsed.positionals[index];
  if (!value) throw new UsageError(`missing ${what}`);
  return value;
}

/** Fixed-width columns for list output. */
export function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function printCheckItems(
  io: CliIo,
  items: ReadonlyArray<{ level: "ok" | "warn" | "fail"; message: string }>,
): number {
  for (const item of items) io.out(`[${item.level}] ${item.message}`);
  const failed = items.filter((item) => item.level === "fail").length;
  io.out(failed ? `${failed} check(s) failed` : "all checks passed");
  return failed ? 1 : 0;
}
