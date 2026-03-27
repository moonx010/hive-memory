import type { HiveDatabase } from "../db/database.js";
import type { ACLContext } from "./types.js";
import { getCurrentRequestContext } from "../request-context.js";

/**
 * Resolve an ACLContext for the current request.
 * Returns undefined when ACL is not enabled (CORTEX_ACL !== "on") or the
 * request has no authenticated user.
 */
export function resolveACL(db: HiveDatabase): ACLContext | undefined {
  if (process.env["CORTEX_ACL"] !== "on") return undefined;
  const ctx = getCurrentRequestContext();
  if (!ctx.userId) return undefined;
  const labels = db.getUserLabels(ctx.userId);
  const user = db.listUsers().find((u) => u.id === ctx.userId);
  return {
    userId: ctx.userId,
    userRole: user?.role === "admin" ? "admin" : "member",
    userLabels: labels,
  };
}
