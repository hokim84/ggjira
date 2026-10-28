import type { FciFacts } from "./fci-facts.js";

export const STATIC_RULE = "fci-static-v2";
export const STRUCTURAL_AXES = ["coupling", "complexity", "duplication", "ripple"] as const;
export type StructuralAxis = (typeof STRUCTURAL_AXES)[number];
export interface StaticScore {
  axes: Record<StructuralAxis, number | null>;
  raw: number | null;
  coverage: number;
  confidence: "low" | "medium" | "high";
  reasons: string[];
}
const clamp = (n: number) => Math.max(0, Math.min(1, n));
function q(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return (
    (values.reduce((a, b) => a + b, 0) / values.length +
      (sorted[Math.ceil(sorted.length * 0.9) - 1] ?? 0)) /
    2
  );
}
export const isTestSource = (p: string) =>
  /(^|\/)(__tests__|tests?|Tests|EditorTests)(\/|$)|\.(test|spec)\.[^.]+$|Tests?\.cs$/.test(p);
export const isGeneratedSource = (p: string) =>
  /(^|\/)(vendor|generated|Generated|Packages)(\/|$)|\.(g|generated|designer)\.cs$|\.min\.js$/.test(
    p,
  );

export function structuralFindings(facts: FciFacts, previous?: FciFacts) {
  const findings: Array<{
    axis: StructuralAxis;
    path: string;
    line: number;
    explanation: string;
    suggestion: string;
    sha?: string;
  }> = [];
  const product = (p: string) => !isTestSource(p) && !isGeneratedSource(p);
  const oldEdges = new Set(previous?.edges.map((e) => `${e.from}:${e.to}`) ?? []);
  const newEdges = new Set(facts.edges.map((e) => `${e.from}:${e.to}`));
  for (const edge of facts.edges
    .filter((e) => product(e.from) && product(e.to) && !oldEdges.has(`${e.from}:${e.to}`))
    .slice(0, 3))
    findings.push({
      axis: "coupling",
      path: edge.from,
      line: edge.line,
      explanation: `${edge.to} 참조${previous ? " 추가" : " 확인"}`,
      suggestion: "서로 독립적으로 바뀌어야 하는 파일인지 확인하고 필요하면 경계를 분리하세요.",
    });
  if (previous)
    for (const edge of previous.edges
      .filter((e) => product(e.from) && product(e.to) && !newEdges.has(`${e.from}:${e.to}`))
      .slice(0, 3))
      findings.push({
        axis: "coupling",
        path: edge.from,
        line: edge.line,
        sha: previous.sha,
        explanation: `${edge.to} 참조 제거`,
        suggestion: "제거한 연결의 역할이 다른 곳으로 이동했는지 확인하세요.",
      });
  for (const group of facts.duplicateBodies
    .filter((g) => g.locations.filter((l) => product(l.path)).length > 1)
    .filter(
      (g) =>
        !previous ||
        previous.duplicateBodies
          .find((old) => old.hash === g.hash)
          ?.locations.filter((l) => product(l.path)).length !==
          g.locations.filter((l) => product(l.path)).length,
    )
    .slice(0, 3)) {
    const location = group.locations.find((l) => product(l.path));
    if (location)
      findings.push({
        axis: "duplication",
        ...location,
        explanation: `동일한 정규화 본문이 ${group.locations.filter((l) => product(l.path)).length}곳에 있습니다.`,
        suggestion:
          "같은 규칙을 함께 수정해야 한다면 공통 함수로 통합하고 동작 테스트를 추가하세요.",
      });
  }
  if (previous)
    for (const group of previous.duplicateBodies
      .filter(
        (g) =>
          g.locations.filter((l) => product(l.path)).length >
          (facts.duplicateBodies
            .find((current) => current.hash === g.hash)
            ?.locations.filter((l) => product(l.path)).length ?? 0),
      )
      .slice(0, 3)) {
      const location = group.locations.find((l) => product(l.path));
      if (location)
        findings.push({
          axis: "duplication",
          ...location,
          sha: previous.sha,
          explanation: "이전 커밋에서 반복되던 함수 본문이 줄었습니다.",
          suggestion: "통합한 동작의 경계 조건을 테스트해 개선을 유지하세요.",
        });
    }
  const oldFunctions = new Map(
    previous?.files.flatMap((f) =>
      f.functions.map((fn) => [`${f.path}:${fn.name}`, fn] as const),
    ) ?? [],
  );
  const functions = facts.files
    .filter((f) => product(f.path))
    .flatMap((f) => f.functions.map((fn) => ({ path: f.path, ...fn })))
    .sort((a, b) => b.cyclomatic + b.nesting - a.cyclomatic - a.nesting);
  for (const fn of functions
    .filter(
      (f) =>
        (f.cyclomatic > 1 || f.nesting > 1) &&
        (!previous ||
          oldFunctions.get(`${f.path}:${f.name}`)?.cyclomatic !== f.cyclomatic ||
          oldFunctions.get(`${f.path}:${f.name}`)?.nesting !== f.nesting),
    )
    .slice(0, 3))
    findings.push({
      axis: "complexity",
      path: fn.path,
      line: fn.line,
      explanation: `${fn.name}: 분기 복잡도 ${oldFunctions.get(`${fn.path}:${fn.name}`)?.cyclomatic ?? "—"} → ${fn.cyclomatic}, 중첩 ${oldFunctions.get(`${fn.path}:${fn.name}`)?.nesting ?? "—"} → ${fn.nesting}`,
      suggestion: "독립적인 조건을 작은 함수로 분리하고 경계 조건을 테스트하세요.",
    });
  function consumers(data: FciFacts | undefined) {
    const byTarget = new Map<string, Set<string>>();
    for (const e of data?.edges ?? [])
      if (product(e.from) && product(e.to)) {
        const from = byTarget.get(e.to) ?? new Set<string>();
        from.add(e.from);
        byTarget.set(e.to, from);
      }
    return byTarget;
  }
  const oldConsumers = consumers(previous);
  for (const [p, count] of [...consumers(facts)]
    .filter(
      ([p, from]) => from.size > 1 && (!previous || from.size !== (oldConsumers.get(p)?.size ?? 0)),
    )
    .map(([p, from]) => [p, from.size] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3))
    findings.push({
      axis: "ripple",
      path: p,
      line: 1,
      explanation: `${count}개 파일이 직접 참조합니다. 공용화의 정상적인 결과일 수도 있습니다.`,
      suggestion: "공개 계약 변경 시 소비자와 호환성을 확인하세요.",
    });
  return findings;
}

/** Versioned structural heuristic; never consumes AI grades, churn, LOC or PR effort. */
export function scoreStructure(facts: FciFacts): StaticScore {
  const files = facts.files.filter((f) => !isTestSource(f.path) && !isGeneratedSource(f.path));
  const good = files.filter((f) => f.parsed);
  const unsupported = facts.sourceCounts.unsupported.filter(
    (p) => !isTestSource(p) && !isGeneratedSource(p),
  );
  const coverage = good.length / Math.max(1, files.length + unsupported.length);
  const paths = new Set(good.map((f) => f.path));
  const edges = facts.edges.filter((e) => paths.has(e.from) && paths.has(e.to) && e.from !== e.to);
  const outgoing = new Map([...paths].map((p) => [p, new Set<string>()]));
  const incoming = new Map([...paths].map((p) => [p, new Set<string>()]));
  for (const e of edges) {
    outgoing.get(e.from)?.add(e.to);
    incoming.get(e.to)?.add(e.from);
  }
  function reachable(start: string, graph: Map<string, Set<string>>) {
    const seen = new Set<string>();
    const todo = [...(graph.get(start) ?? [])];
    while (todo.length) {
      const p = todo.pop() as string;
      if (seen.has(p)) continue;
      seen.add(p);
      todo.push(...(graph.get(p) ?? []));
    }
    return seen;
  }
  const cyclic = [...paths].filter((p) => reachable(p, outgoing).has(p)).length;
  const functions = good.flatMap((f) => f.functions);
  const tokenTotal = functions.reduce((n, f) => n + (f.tokens ?? 0), 0);
  const duplicates = facts.duplicateBodies.reduce((n, group) => {
    const locations = group.locations.filter((l) => paths.has(l.path));
    return n + Math.max(0, locations.length - 1) * (group.tokens ?? 0);
  }, 0);
  const unresolved = facts.unresolvedReferences?.filter((r) => paths.has(r.path)).length ?? 0;
  const axes: StaticScore["axes"] = {
    coupling:
      100 *
      (0.7 * q([...outgoing.values()].map((v) => clamp(v.size / 10))) +
        (0.3 * cyclic) / Math.max(1, paths.size)),
    complexity:
      100 *
      q(
        functions.map(
          (f) => 0.6 * clamp((f.cyclomatic - 1) / 14) + 0.4 * clamp((f.nesting - 1) / 4),
        ),
      ),
    duplication: tokenTotal ? 100 * clamp(duplicates / tokenTotal) : 0,
    ripple:
      100 *
      q(
        [...paths].map((p) => {
          const consumers = reachable(p, incoming);
          consumers.delete(p);
          return clamp(consumers.size / 20);
        }),
      ),
  };
  const reasons = [...facts.uncertainties];
  if (unresolved)
    reasons.push(
      `${unresolved} internal reference candidates could not be resolved; graph observations are partial.`,
    );
  if (unresolved && !edges.length) {
    axes.coupling = null;
    axes.ripple = null;
  }
  if (!good.length || coverage < 0.8) {
    for (const axis of STRUCTURAL_AXES) axes[axis] = null;
    reasons.push(
      !good.length
        ? "No assessable product source at this commit."
        : "Product source parsing coverage is below 80%.",
    );
  }
  const values = Object.values(axes);
  return {
    axes,
    raw: values.some((v) => v === null)
      ? null
      : (values as number[]).reduce((a, b) => a + b, 0) / 4,
    coverage,
    confidence: coverage < 1 || unresolved ? "low" : reasons.length ? "medium" : "high",
    reasons,
  };
}
