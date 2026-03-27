import { z } from "zod";
import type { CortexStore } from "../store.js";
import { registerProjectTools } from "./project-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerSessionTools } from "./session-tools.js";
import { registerBrowseTools } from "./browse-tools.js";
import { registerTrailTools } from "./trail-tools.js";
import { registerConnectorTools } from "./connector-tools.js";
import { registerTeamTools } from "./team-tools.js";
import { registerContextTools } from "./context-tools.js";
import { registerMeetingTools } from "./meeting-tools.js";
import { registerStewardTools } from "./steward-tools.js";
import { registerAdvisorTools } from "./advisor-tools.js";
import { registerUserTools } from "./user-tools.js";
import { recordToolCall } from "../observability/metrics.js";
import { logAudit, classifyAction } from "../observability/audit.js";
import { getCurrentRequestContext } from "../request-context.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type SafeToolFn = (
  name: string,
  description: string,
  schema: Record<string, z.ZodType>,
  handler: ToolHandler,
) => void;

/** Per-request user context interface (kept for backward compat). */
export interface UserContext {
  userId?: string;
  userName?: string;
}

function wrapHandler(name: string, handler: ToolHandler): ToolHandler {
  return async (args) => {
    recordToolCall(name);
    try {
      const result = await handler(args);
      const ctx = getCurrentRequestContext();
      logAudit({
        userId: ctx.userId ?? "anonymous",
        action: classifyAction(name),
        toolName: name,
        query: (args.query ?? args.content ?? args.title) as string | undefined,
        entityId: (args.id ?? args.entity_id) as string | undefined,
        resultCount: Array.isArray(result.content) ? result.content.length : undefined,
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

export function registerTools(
  server: {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodType>,
      handler: ToolHandler,
    ) => void;
  },
  store: CortexStore,
  userContext?: UserContext,
) {
  const safeTool: SafeToolFn = (name, description, schema, handler) =>
    server.tool(name, description, schema, wrapHandler(name, handler));

  const db = store.database;

  // v2 tools (existing — backward compatible)
  registerProjectTools(safeTool, store);
  registerMemoryTools(safeTool, store);
  registerSessionTools(safeTool, store);

  // v3 new tools
  registerBrowseTools(safeTool, db);
  registerTrailTools(safeTool, db);
  registerConnectorTools(safeTool, db, store);
  registerTeamTools(safeTool, store);
  registerContextTools(safeTool, store);
  registerMeetingTools(safeTool, store);
  registerStewardTools(safeTool, store);
  registerAdvisorTools(safeTool, db);
  registerUserTools(safeTool, db, userContext);

  // Audit log tool (admin only)
  safeTool(
    "memory_audit_log",
    "Retrieve recent MCP tool call audit log. Admin-only tool.",
    {
      limit: z.number().optional().describe("Number of entries to return (default: 100)"),
    },
    async (args) => {
      const alsCtx = getCurrentRequestContext();
      const ctx = alsCtx.userId ? alsCtx : (userContext ?? {});
      if (ctx.userId) {
        const { listUsers } = await import("../auth.js");
        const allUsers = listUsers(db);
        const caller = allUsers.find((u) => u.id === ctx.userId);
        if (caller && caller.role !== "admin") {
          return { content: [{ type: "text" as const, text: "Error: memory_audit_log requires admin role" }], isError: true };
        }
      }
      const { getAuditLog } = await import("../observability/audit.js");
      const entries = getAuditLog(args.limit as number | undefined);
      return { content: [{ type: "text" as const, text: JSON.stringify(entries, null, 2) }] };
    },
  );
}
