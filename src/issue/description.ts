/**
 * Renders the wiki-markup sections Router writes into Jira for people to read: the plan block on
 * a parent and each plan task's description. Router never reads them back — what a job runs under
 * is the approved plan Router stored itself (ADR 0047).
 */
export interface RenderSection {
  heading: string;
  level?: number;
  scalars?: Array<[label: string, value: string | null]>;
  items?: string[];
}

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
