import { existsSync } from "node:fs";
import path from "node:path";

/** True when `cwd` already has a `ggjira.config.json` (of any config version). */
export function hasLocalConfig(cwd: string): boolean {
  return existsSync(path.join(cwd, "ggjira.config.json"));
}
