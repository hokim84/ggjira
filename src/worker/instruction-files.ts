import { homedir } from "node:os";
import path from "node:path";

/**
 * Instruction files Claude Code would load from the folders above `cwd`, the repository a job
 * runs in (ADR 0065). A worker home may sit inside another project, such as the GGJIRA checkout;
 * without this an agent read that project's CLAUDE.md or AGENTS.md as its own rules (KAN-47).
 *
 * The result is Claude Code's `claudeMdExcludes`: absolute paths with `/` separators. The
 * repository's own files stay. In the user's home folder only the project-style files are
 * listed, so `~/.claude/CLAUDE.md` and `~/.claude/rules/` stay the operator's choice.
 */
export function instructionFilesAbove(cwd: string, userHome: string = homedir()): string[] {
  const files: string[] = [];
  const home = path.resolve(userHome);
  let dir = path.resolve(cwd);
  for (;;) {
    const parent = path.dirname(dir);
    if (parent === dir) return files;
    dir = parent;
    const names = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md"];
    if (dir !== home) names.push(".claude/CLAUDE.md", ".claude/AGENTS.md", ".claude/rules/**");
    const prefix = dir.split(path.sep).join("/").replace(/\/$/, "");
    for (const name of names) files.push(`${prefix}/${name}`);
  }
}
