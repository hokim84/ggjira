import { z } from "zod";
import { JOB_KINDS } from "./protocol.js";

/**
 * What a `DecisionProvider.decide(context)` returns (docs/router-service-implementation-plan.md
 * §2 "라우팅과 배정"). It expresses *intent* — planning vs. implementation,
 * which workspace/repository, which capabilities are required, and an
 * optional pinned worker — never a specific worker assignment; the scheduler
 * picks the actual worker once one is available.
 */
export const RouteDispatchSchema = z.object({
  target: z.enum(JOB_KINDS),
  workspaceId: z.string().min(1),
  repositoryId: z.string().min(1),
  requiredCapabilities: z.array(z.string().min(1)).default([]),
  pinnedWorkerId: z.string().min(1).optional(),
  reason: z.string().min(1),
});
export type RouteDispatch = z.infer<typeof RouteDispatchSchema>;

export const RouteHoldSchema = z.object({
  target: z.enum(["wait", "human", "ignore"]),
  reason: z.string().min(1),
  /** Set when the hold is a known, human-fixable gap rather than a free-text reason: `not_ready`
   *  is an implementation request whose scope contract is incomplete (ADR 0034). */
  code: z.enum(["not_ready"]).optional(),
  /** For `not_ready`: which parts of the contract are missing. */
  missing: z.array(z.enum(["acceptance", "verification"])).optional(),
});
export type RouteHold = z.infer<typeof RouteHoldSchema>;

export const RouteResultSchema = z.union([RouteDispatchSchema, RouteHoldSchema]);
export type RouteResult = z.infer<typeof RouteResultSchema>;

export function isRouteDispatch(result: RouteResult): result is RouteDispatch {
  return result.target === "planning" || result.target === "implementation";
}
