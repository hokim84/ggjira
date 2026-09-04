import { JiraApiError } from "../jira/client.js";

/** A setup-time failure meant to be shown to the person running `ggjira setup`, not a stack trace. */
export class SetupError extends Error {}

/** Turns a Jira API failure into a hint a person can act on, for setup-time error messages. */
export function describeJiraError(error: unknown): string {
  if (error instanceof JiraApiError) {
    switch (error.status) {
      case 401:
        return "Invalid email or API token.";
      case 403:
        return "Permission denied -- this Jira account needs Browse/Create/Edit Issues on the project.";
      case 404:
        return "Not found -- check the Jira URL and project key.";
      default:
        return `Jira request failed (status ${error.status}): ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
