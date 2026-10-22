import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { setImmediate as yieldToHeartbeat } from "node:timers/promises";
import { promisify } from "node:util";
import Parser from "web-tree-sitter";
import { FCI_ANALYZER } from "../contracts/fci.js";

const exec = promisify(execFile);
export async function fciGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
  return (
    await exec("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60000,
      ...(signal ? { signal } : {}),
    })
  ).stdout.trim();
}
export const fciHash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const require = createRequire(import.meta.url);
let initialized: Promise<void> | undefined;
const languages = new Map<string, Parser.Language>();
async function grammar(name: string) {
  initialized ??= Parser.init();
  await initialized;
  let value = languages.get(name);
  if (!value) {
    value = await Parser.Language.load(
      require.resolve(`tree-sitter-wasms/out/tree-sitter-${name}.wasm`),
    );
    languages.set(name, value);
  }
  return value;
}
const extensions: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".cs": "c_sharp",
};
const ignored =
  /(^|\/)(\.git|node_modules|Library|Temp|Obj|obj|Logs|UserSettings|Build|Builds|dist|bin|coverage|__pycache__)(\/|$)/;
type Evidence = { path: string; line: number };
export interface FciFacts {
  graph?: { cycles: string[][]; fanIn: Record<string, number>; fanOut: Record<string, number> };
  analyzer: string;
  sha: string;
  files: Array<{
    path: string;
    language: string;
    parsed: boolean;
    functions: Array<{ name: string; line: number; cyclomatic: number; nesting: number }>;
    references: Array<{ name: string; line: number }>;
    interfaces: Evidence[];
  }>;
  edges: Array<{ from: string; to: string; line: number; kind: string }>;
  duplicateBodies: Array<{ hash: string; locations: Evidence[] }>;
  history: { commits: number; cochanges: Array<{ files: string[]; count: number }> };
  tests: { files: string[]; frameworkHints: string[] };
  unity: {
    assemblies: Array<{ path: string; name: string; references: string[] }>;
    serializedReferences: Array<{
      path: string;
      line: number;
      guid: string;
      target: string | null;
    }>;
  };
  uncertainties: string[];
  sourceCounts: { supported: number; unsupported: string[] };
}
/** Worktree is pinned; only tracked, regular files inside it can become evidence. */
export async function collectFciFacts(
  cwd: string,
  sha: string,
  signal?: AbortSignal,
): Promise<FciFacts> {
  if ((await fciGit(cwd, ["rev-parse", "HEAD"], signal)) !== sha)
    throw new Error("FCI observation SHA differs from worktree HEAD");
  const tracked = (await fciGit(cwd, ["ls-tree", "-rz", "--name-only", sha], signal))
    .split("\0")
    .filter((p) => p && !ignored.test(p))
    .sort();
  const texts = new Map<string, string>();
  const uncertainties: string[] = [];
  for (const p of tracked) {
    const absolute = path.resolve(cwd, p);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`))
      throw new Error("unsafe tracked path");
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      uncertainties.push(`Skipped non-regular file: ${p}`);
      continue;
    }
    if (stat.size > 2_000_000) {
      uncertainties.push(`File exceeds 2 MB observation limit: ${p}`);
      continue;
    }
    if (
      extensions[path.extname(p)] ||
      /\.(asmdef|asmref|meta|unity|prefab|asset|csproj|json|md)$/.test(p)
    ) {
      const text = readFileSync(absolute, "utf8");
      if (!text.includes("\0")) texts.set(p, text);
      else uncertainties.push(`Binary asset: ${p}`);
    }
  }
  const files: FciFacts["files"] = [];
  const edges: FciFacts["edges"] = [];
  const bodies = new Map<string, Evidence[]>();
  const unsupported = tracked.filter((p) => /\.(cpp|c|h|hpp|java|gd|go|rs|rb|swift|kt)$/.test(p));
  if (unsupported.length)
    uncertainties.push(
      `No AST adapter for ${unsupported.length} source files; AI observations must identify this coverage gap.`,
    );
  for (const [p, text] of texts) {
    await yieldToHeartbeat();
    const language = extensions[path.extname(p)];
    if (!language) continue;
    const lang = await grammar(language);
    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(text);
    if (!tree) {
      parser.delete();
      throw new Error(`Cannot parse ${p}`);
    }
    const entry: FciFacts["files"][number] = {
      path: p,
      language,
      parsed: !tree.rootNode.hasError,
      functions: [],
      references: [],
      interfaces: [],
    };
    if (!entry.parsed) uncertainties.push(`Parser gaps in ${p}; extracted syntax is partial.`);
    function walk(node: Parser.SyntaxNode) {
      if (
        /^(import_statement|import_from_statement|import_declaration|using_directive)$/.test(
          node.type,
        )
      )
        entry.references.push({ name: node.text, line: node.startPosition.row + 1 });
      if (
        /^(function_declaration|function_definition|method_definition|method_declaration|constructor_declaration|arrow_function)$/.test(
          node.type,
        )
      ) {
        let cyclomatic = 1;
        let maxNesting = 0;
        function complexity(n: Parser.SyntaxNode, depth: number) {
          const branch =
            /^(if_statement|for_statement|for_in_statement|foreach_statement|while_statement|do_statement|catch_clause|case_switch_label|switch_case|conditional_expression|case_clause|except_clause|elif_clause)$/.test(
              n.type,
            );
          if (branch) cyclomatic++;
          if (["&&", "||", "??", "and", "or"].includes(n.type)) cyclomatic++;
          const next = depth + (branch ? 1 : 0);
          maxNesting = Math.max(maxNesting, next);
          for (const child of n.children) complexity(child, next);
        }
        complexity(node, 0);
        entry.functions.push({
          name: node.childForFieldName("name")?.text ?? "<anonymous>",
          line: node.startPosition.row + 1,
          cyclomatic,
          nesting: maxNesting,
        });
        const body = node.childForFieldName("body")?.text.replace(/\s+/g, "") ?? "";
        if (body.length >= 80) {
          const hash = fciHash(body);
          bodies.set(hash, [
            ...(bodies.get(hash) ?? []),
            { path: p, line: node.startPosition.row + 1 },
          ]);
        }
      }
      if (
        (/declaration$/.test(node.type) && /^(export\b|public\b)/.test(node.text)) ||
        (language === "python" &&
          node.type === "function_definition" &&
          !node.childForFieldName("name")?.text.startsWith("_"))
      )
        entry.interfaces.push({ path: p, line: node.startPosition.row + 1 });
      for (const child of node.namedChildren) walk(child);
    }
    walk(tree.rootNode);
    tree.delete();
    parser.delete();
    files.push(entry);
  }
  const paths = new Set(files.map((f) => f.path));
  for (const file of files)
    for (const ref of file.references) {
      const match = ref.name.match(/["'](\.[^"']+)["']/)?.[1];
      if (match) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file.path), match));
        const target = [
          base,
          ...[".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"].map((ext) => base + ext),
        ].find((p) => paths.has(p));
        if (target)
          edges.push({
            from: file.path,
            to: target,
            line: ref.line,
            kind: "resolved-relative-import",
          });
      }
      if (file.language === "python") {
        const module = ref.name.match(/^(?:from|import)\s+([\w.]+)/)?.[1];
        if (module) {
          const target = [
            `${module.replaceAll(".", "/")}.py`,
            path.posix.join(
              path.posix.dirname(file.path),
              `${module.replace(/^\.+/, "").replaceAll(".", "/")}.py`,
            ),
          ].find((p) => paths.has(p));
          if (target)
            edges.push({
              from: file.path,
              to: target,
              line: ref.line,
              kind: "resolved-python-module",
            });
        }
      }
    }
  const guidPaths = new Map<string, string>();
  for (const [p, text] of texts)
    if (p.endsWith(".meta")) {
      const guid = text.match(/^guid:\s*([a-f0-9]{32})/m)?.[1];
      if (guid) guidPaths.set(guid, p.slice(0, -5));
    }
  const unity: FciFacts["unity"] = { assemblies: [], serializedReferences: [] };
  for (const [p, text] of texts) {
    if (/\.(asmdef|asmref)$/.test(p))
      try {
        const json = JSON.parse(text);
        const refs = Array.isArray(json.references)
          ? json.references
          : typeof json.reference === "string"
            ? [json.reference]
            : [];
        unity.assemblies.push({
          path: p,
          name: typeof json.name === "string" ? json.name : p,
          references: refs.filter((r: unknown) => typeof r === "string"),
        });
      } catch {
        uncertainties.push(`Invalid assembly JSON: ${p}`);
      }
    if (/\.(unity|prefab|asset)$/.test(p))
      text.split(/\r?\n/).forEach((line, i) => {
        for (const match of line.matchAll(/guid:\s*([a-f0-9]{32})/g))
          unity.serializedReferences.push({
            path: p,
            line: i + 1,
            guid: match[1] as string,
            target: guidPaths.get(match[1] as string) ?? null,
          });
      });
  }
  for (const assembly of unity.assemblies)
    for (const reference of assembly.references) {
      const target = reference.startsWith("GUID:")
        ? guidPaths.get(reference.slice(5))
        : unity.assemblies.find((a) => a.name === reference)?.path;
      if (target)
        edges.push({ from: assembly.path, to: target, line: 1, kind: "assembly-reference" });
    }
  const log = await fciGit(
    cwd,
    ["log", sha, "--no-merges", "-n", "200", "--format=FCI_COMMIT:%H", "--name-only"],
    signal,
  );
  const adjacency = new Map<string, Set<string>>();
  const fanIn: Record<string, number> = {};
  const fanOut: Record<string, number> = {};
  for (const edge of edges) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, new Set());
    adjacency.get(edge.from)?.add(edge.to);
  }
  for (const [from, targets] of adjacency) {
    fanOut[from] = targets.size;
    for (const to of targets) fanIn[to] = (fanIn[to] ?? 0) + 1;
  }
  const cycles: string[][] = [];
  const visited = new Set<string>();
  for (const start of [...adjacency.keys()].sort()) {
    if (visited.has(start)) continue;
    const reach = (node: string) => {
      const seen = new Set<string>();
      const pending = [node];
      while (pending.length) {
        const p = pending.pop() as string;
        if (seen.has(p)) continue;
        seen.add(p);
        pending.push(...(adjacency.get(p) ?? []));
      }
      return seen;
    };
    const component = [...reach(start)].filter((target) => reach(target).has(start)).sort();
    for (const node of component) visited.add(node);
    if (component.length > 1 || adjacency.get(start)?.has(start)) cycles.push(component);
  }
  const commits = log.split("FCI_COMMIT:").slice(1);
  const cochanges = new Map<string, number>();
  for (const commit of commits) {
    const changed = commit
      .split(/\r?\n/)
      .slice(1)
      .filter((p) => paths.has(p))
      .sort();
    if (changed.length > 40) {
      uncertainties.push(
        "History commit with >40 source files excluded from co-change pairs; bulk changes are not a risk penalty.",
      );
      continue;
    }
    for (let i = 0; i < changed.length; i++)
      for (let j = i + 1; j < changed.length; j++) {
        const key = JSON.stringify([changed[i], changed[j]]);
        cochanges.set(key, (cochanges.get(key) ?? 0) + 1);
      }
  }
  if (commits.length < 10)
    uncertainties.push(
      "Sparse Git history (<10 commits); do not infer low or high risk from absent observations.",
    );
  if (files.some((f) => f.language === "c_sharp"))
    uncertainties.push(
      "C# syntax and assembly edges are observed; reflection, runtime dispatch, Unity lifecycle and compiler-symbol resolution are not proven.",
    );
  return {
    analyzer: FCI_ANALYZER,
    graph: { cycles, fanIn, fanOut },
    sha,
    files,
    edges,
    duplicateBodies: [...bodies]
      .filter(([, locations]) => locations.length > 1)
      .map(([hash, locations]) => ({ hash, locations })),
    history: {
      commits: commits.length,
      cochanges: [...cochanges]
        .map(([key, count]) => ({ files: JSON.parse(key) as string[], count }))
        .sort((a, b) => b.count - a.count || a.files.join().localeCompare(b.files.join())),
    },
    tests: {
      files: tracked.filter((p) =>
        /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.|Tests?\.cs$|^test_/.test(p),
      ),
      frameworkHints: [...texts]
        .filter(([p]) => /package\.json$|asmdef$|csproj$/.test(p))
        .map(([p]) => p),
    },
    unity,
    uncertainties,
    sourceCounts: { supported: files.length, unsupported },
  };
}
