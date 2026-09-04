import { randomUUID } from "node:crypto";
import { type AgentRole, isAgentRole } from "../agent/role.js";
import type { JiraGateway } from "../jira/gateway.js";
import type { JiraIssue } from "../jira/types.js";
import { GGJIRA_VERSION } from "../version.js";
import { getItems, getScalar, parseSections, renderSections } from "./description.js";
import { AGENT_LABEL, DISABLED_LABEL, REGISTRATION_PROPERTY } from "./types.js";
import type { AgentProfile, AgentProfileInput, AgentRegistration } from "./types.js";

const AGENT_SUMMARY_RE = /^\[AGENT\]\s*(.+)$/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function agentProfileSummary(agentId: string): string {
  return `[AGENT] ${agentId}`;
}

export class InvalidProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProfileError";
  }
}

export class ProfileNotFoundError extends Error {
  constructor(readonly agentId: string) {
    super(`No Agent Profile found for agentId "${agentId}"`);
    this.name = "ProfileNotFoundError";
  }
}

export class ProfileAlreadyRegisteredError extends Error {
  constructor(
    readonly issueKey: string,
    readonly existing: AgentRegistration,
  ) {
    super(
      `Agent Profile ${issueKey} is already registered to another machine ` +
        `(${existing.machineId}, registered ${existing.registeredAt}). Pass takeover: true to force.`,
    );
    this.name = "ProfileAlreadyRegisteredError";
  }
}

export class ProfileClaimLostError extends Error {
  constructor(readonly issueKey: string) {
    super(`Lost the registration race for ${issueKey} -- another machine claimed it first.`);
    this.name = "ProfileClaimLostError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses a `[AGENT] <agentId>` issue. `registration` is fetched separately (a Jira issue property). */
export function parseAgentProfile(
  issue: JiraIssue,
  registration: AgentRegistration | null,
): AgentProfile {
  const summaryMatch = issue.summary.match(AGENT_SUMMARY_RE);
  if (!summaryMatch?.[1]) {
    throw new InvalidProfileError(
      `Issue ${issue.key} has the ${AGENT_LABEL} label but its summary "${issue.summary}" is not in "[AGENT] <agentId>" form`,
    );
  }
  const agentId = summaryMatch[1].trim();

  const sections = parseSections(issue.description ?? "");
  const roleRaw = getScalar(sections, "Agent Profile", "Role");
  if (!roleRaw || !isAgentRole(roleRaw)) {
    throw new InvalidProfileError(
      `Agent Profile ${issue.key} (${agentId}) has a missing or invalid Role ("${roleRaw ?? ""}")`,
    );
  }

  return {
    issueKey: issue.key,
    agentId,
    displayName: getScalar(sections, "Agent Profile", "Display Name") ?? agentId,
    role: roleRaw as AgentRole,
    preset: getScalar(sections, "Agent Profile", "Preset"),
    capabilities: getItems(sections, "Capabilities"),
    workStyle: getItems(sections, "Work Style"),
    humanInstructions: getItems(sections, "Human Instructions"),
    enabled: !issue.labels.includes(DISABLED_LABEL),
    registration,
  };
}

/** Renders the description an Agent Profile issue is created with. */
export function renderProfileDescription(input: AgentProfileInput): string {
  return renderSections([
    {
      heading: "Agent Profile",
      scalars: [
        ["Agent ID", input.agentId],
        ["Display Name", input.displayName],
        ["Role", input.role],
        ["Preset", input.preset],
      ],
    },
    { heading: "Capabilities", items: input.capabilities },
    { heading: "Work Style", items: input.workStyle },
    { heading: "Human Instructions", items: input.humanInstructions },
  ]);
}

/**
 * Lists Agent Profile issues in a project. Malformed issues (labeled but not
 * in `[AGENT] <id>` form, or missing a valid Role) are skipped rather than
 * failing the whole roster -- callers working with one specific profile
 * (findAgentProfileById, createAgentProfile) surface those errors directly.
 */
export async function findAgentProfiles(
  jira: JiraGateway,
  projectKey: string,
  opts?: { includeDisabled?: boolean },
): Promise<AgentProfile[]> {
  const issues = await jira.searchIssues(
    `project = "${projectKey}" AND labels = "${AGENT_LABEL}" ORDER BY created ASC`,
  );
  const profiles = await Promise.all(
    issues.map(async (issue) => {
      const registration = (await jira.getIssueProperty(
        issue.key,
        REGISTRATION_PROPERTY,
      )) as AgentRegistration | null;
      try {
        return parseAgentProfile(issue, registration);
      } catch {
        return null;
      }
    }),
  );
  const valid = profiles.filter((p): p is AgentProfile => p !== null);
  return opts?.includeDisabled === false ? valid.filter((p) => p.enabled) : valid;
}

export async function findAgentProfileById(
  jira: JiraGateway,
  projectKey: string,
  agentId: string,
): Promise<AgentProfile | null> {
  const profiles = await findAgentProfiles(jira, projectKey, { includeDisabled: true });
  return profiles.find((p) => p.agentId === agentId) ?? null;
}

/**
 * Creates a new Agent Profile issue and unassigns it (advanced_plan.md
 * §2.11, so it never gets polled as work). Does not check for an existing
 * agentId -- callers ensure idempotency with findAgentProfileById first.
 */
export async function createAgentProfile(
  jira: JiraGateway,
  input: AgentProfileInput & { projectKey: string; issueTypeName: string },
): Promise<AgentProfile> {
  if (!AGENT_ID_RE.test(input.agentId)) {
    throw new InvalidProfileError(
      `Invalid agentId "${input.agentId}" -- must match ${AGENT_ID_RE.source}`,
    );
  }

  const description = renderProfileDescription(input);
  const { key } = await jira.createIssue({
    projectKey: input.projectKey,
    issueTypeName: input.issueTypeName,
    summary: agentProfileSummary(input.agentId),
    description,
    labels: [AGENT_LABEL],
  });
  await jira.assignIssue(key, null);

  return {
    issueKey: key,
    agentId: input.agentId,
    displayName: input.displayName,
    role: input.role,
    preset: input.preset,
    capabilities: input.capabilities,
    workStyle: input.workStyle,
    humanInstructions: input.humanInstructions,
    enabled: true,
    registration: null,
  };
}

export async function disableAgentProfile(jira: JiraGateway, profile: AgentProfile): Promise<void> {
  await jira.addLabel(profile.issueKey, DISABLED_LABEL);
}

export async function getRegistration(
  jira: JiraGateway,
  issueKey: string,
): Promise<AgentRegistration | null> {
  return (await jira.getIssueProperty(issueKey, REGISTRATION_PROPERTY)) as AgentRegistration | null;
}

export interface ClaimAgentProfileOptions {
  /** Force-overwrite a registration held by a different machine. */
  takeover?: boolean;
  /** Delay before re-reading the property to detect a concurrent claim; 0 in tests. */
  settleMs?: number;
  now?: () => Date;
  claimTokenFactory?: () => string;
  ggjiraVersion?: string;
}

export type ClaimOutcome = "claimed" | "reclaimed" | "taken_over";

export interface ClaimAgentProfileResult {
  outcome: ClaimOutcome;
  registration: AgentRegistration;
}

/**
 * Registers this machine as the owner of an Agent Profile: read -> refuse or
 * overwrite -> write -> settle -> re-read to detect a concurrent claim
 * (advanced_plan.md §2.2). This is MVP-level protection (last writer wins on
 * a genuine race), not a distributed lock.
 */
export async function claimAgentProfile(
  jira: JiraGateway,
  profile: Pick<AgentProfile, "issueKey" | "agentId">,
  machineId: string,
  opts: ClaimAgentProfileOptions = {},
): Promise<ClaimAgentProfileResult> {
  const settleMs = opts.settleMs ?? 1000;
  const now = opts.now ?? (() => new Date());
  const claimTokenFactory = opts.claimTokenFactory ?? randomUUID;
  const ggjiraVersion = opts.ggjiraVersion ?? GGJIRA_VERSION;

  const existing = await getRegistration(jira, profile.issueKey);
  if (existing && existing.machineId !== machineId && !opts.takeover) {
    throw new ProfileAlreadyRegisteredError(profile.issueKey, existing);
  }

  const self = await jira.getMyself();
  const claimToken = claimTokenFactory();
  const registration: AgentRegistration = {
    machineId,
    agentId: profile.agentId,
    jiraAccountId: self.accountId,
    registeredAt: now().toISOString(),
    claimToken,
    ggjiraVersion,
  };
  await jira.setIssueProperty(profile.issueKey, REGISTRATION_PROPERTY, registration);

  if (settleMs > 0) await sleep(settleMs);

  const confirmed = await getRegistration(jira, profile.issueKey);
  if (confirmed?.claimToken !== claimToken) {
    throw new ProfileClaimLostError(profile.issueKey);
  }

  const changed = !existing || existing.machineId !== machineId;
  if (changed) {
    await jira.addComment(
      profile.issueKey,
      [
        "GGJIRA agent registered.",
        `agent: ${profile.agentId}`,
        `machine: ${machineId.slice(0, 8)}`,
        `at: ${registration.registeredAt}`,
      ].join("\n"),
    );
  }

  const outcome: ClaimOutcome = !existing
    ? "claimed"
    : existing.machineId === machineId
      ? "reclaimed"
      : "taken_over";
  return { outcome, registration };
}
