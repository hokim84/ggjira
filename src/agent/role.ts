import type { AgentRole } from "../config.js";

export type { AgentRole };

export const AGENT_ROLES: readonly AgentRole[] = ["pm", "implement"];

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}
