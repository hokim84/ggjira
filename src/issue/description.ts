/**
 * A tiny wiki-markup section parser/renderer for GGJIRA-structured issue descriptions (the
 * "Required Capabilities" / "Dependencies" sections a requirement or PM subtask carries, and the
 * plan block Router renders). Jira Cloud's v2 API returns descriptions edited through the ADF UI
 * as wiki markup on read (headings as `h2. Title`, bullets as `* item`, bold as `*text*`), so this
 * format round-trips through a human editing the issue in the browser.
 */
export interface ParsedSection {
  scalars: Record<string, string | null>;
  items: string[];
}

export type ParsedSections = Map<string, ParsedSection>;

export interface RenderSection {
  heading: string;
  level?: number;
  scalars?: Array<[label: string, value: string | null]>;
  items?: string[];
}

/** Lowercases and strips everything but letters/digits, so "Agent ID" and "agentid" compare equal. */
export function normalizeKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stripHeadingDecoration(title: string): string {
  let t = title.trim();
  const wrapped = t.match(/^\*(.+)\*$/) ?? t.match(/^_(.+)_$/);
  if (wrapped?.[1]) t = wrapped[1].trim();
  t = t.replace(/:\s*$/, "").trim();
  return t;
}

function isNullishValue(value: string): boolean {
  return value === "" || value === "-" || /^\(?none\)?$/i.test(value);
}

const CODE_FENCE_RE = /^\{(code(:[^}]*)?|noformat)\}$/i;

/** Parses a wiki-markup description into a map of normalized section name -> scalars/items. */
export function parseSections(text: string): ParsedSections {
  const sections: ParsedSections = new Map();
  let current: ParsedSection | undefined;
  let inFence = false;

  const ensureSection = (key: string): ParsedSection => {
    const existing = sections.get(key);
    if (existing) return existing;
    const created: ParsedSection = { scalars: {}, items: [] };
    sections.set(key, created);
    return created;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();

    if (CODE_FENCE_RE.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed === "") continue;

    const heading = trimmed.match(/^h[1-6]\.\s*(.+)$/);
    if (heading?.[1]) {
      const title = stripHeadingDecoration(heading[1]);
      current = ensureSection(normalizeKey(title));
      continue;
    }

    // Before the first heading, still parse (so a preamble doesn't get
    // misread as belonging to whatever section happens to follow) but the
    // result is never looked up -- callers only query known section names.
    const target = current ?? ensureSection("__preamble__");

    const scalar = trimmed.match(/^([A-Za-z][A-Za-z ]*?)\s*:\s*(.*)$/);
    if (scalar?.[1] !== undefined && scalar[2] !== undefined) {
      const value = scalar[2].trim();
      target.scalars[normalizeKey(scalar[1])] = isNullishValue(value) ? null : value;
      continue;
    }

    const item = trimmed.replace(/^[*#-]+\s*/, "").trim();
    if (item) target.items.push(item);
  }

  return sections;
}

export function getScalar(sections: ParsedSections, section: string, key: string): string | null {
  return sections.get(normalizeKey(section))?.scalars[normalizeKey(key)] ?? null;
}

export function getItems(sections: ParsedSections, section: string): string[] {
  return sections.get(normalizeKey(section))?.items ?? [];
}

/** Renders sections back into the same wiki-markup shape parseSections() reads. */
export function renderSections(sections: RenderSection[]): string {
  const blocks = sections.map((section) => {
    const lines = [`h${section.level ?? 2}. ${section.heading}`];
    for (const [label, value] of section.scalars ?? []) {
      lines.push(`${label}: ${value === null ? "(none)" : value}`);
    }
    if (section.items?.length) {
      if (section.scalars?.length) lines.push("");
      for (const item of section.items) lines.push(`* ${item}`);
    }
    return lines.join("\n");
  });
  return blocks.join("\n\n");
}
