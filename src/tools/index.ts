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
import type { ACLContext } from "../acl/types.js";
import type { HiveDatabase } from "../db/database.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type SafeToolFn = (
  name: string,
  description: string,
  schema: Record<string, z.ZodType>,
  handler: ToolHandler,
) => void;

/** Immutable per-request user context. Created fresh for each HTTP request. */
export interface UserContext {
  readonly userId?: string;
  readonly userName?: string;
}

/** Getter function that returns the current request's frozen UserContext. */
export type GetUserContext = () => Readonly<UserContext>;

/**
 * Resolver function that builds an ACLContext from the current user context.
 * Returns null when ACL is disabled or the user cannot be resolved.
 */
export type ACLResolver = (userContext: Readonly<UserContext>, db: HiveDatabase) => ACLContext | null;

/** Build an ACLResolver closure. When CORTEX_ACL is not 'on', always returns null. */
function createACLResolver(): ACLResolver {
  return (userContext: Readonly<UserContext>, db: HiveDatabase): ACLContext | null => {
    if (process.env.CORTEX_ACL !== 'on') return null;
    const { userId } = userContext;
    if (!userId) return null;
    const user = db.getUserById(userId);
    if (!user) return null;
    return {
      userId,
      userRole: user.role === 'admin' ? 'admin' : 'member',
      userLabels: db.getUserLabels(userId),
    };
  };
}

function wrapHandler(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
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
  getUserContext?: GetUserContext,
) {
  const safeTool: SafeToolFn = (name, description, schema, handler) =>
    server.tool(name, description, schema, wrapHandler(handler));

  const db = store.database;
  const aclResolver = createACLResolver();

  // v2 tools (existing — backward compatible)
  registerProjectTools(safeTool, store);
  registerMemoryTools(safeTool, store, getUserContext);
  registerSessionTools(safeTool, store, getUserContext);

  // v3 new tools
  registerBrowseTools(safeTool, db, aclResolver, getUserContext);
  registerTrailTools(safeTool, db, aclResolver, getUserContext);
  registerConnectorTools(safeTool, db, store);
  registerTeamTools(safeTool, store);
  registerContextTools(safeTool, store);
  registerMeetingTools(safeTool, store);
  registerStewardTools(safeTool, store);
  registerAdvisorTools(safeTool, db, aclResolver, getUserContext);
  registerUserTools(safeTool, db, getUserContext);
}
