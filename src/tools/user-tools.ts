import { z } from "zod";
import type { HiveDatabase } from "../db/database.js";
import { createUser, listUsers, revokeUser, rotateApiKey } from "../auth.js";
import type { SafeToolFn, UserContext } from "./index.js";
import { getCurrentRequestContext } from "../request-context.js";

export function registerUserTools(safeTool: SafeToolFn, db: HiveDatabase, userContext?: UserContext) {
  safeTool(
    "user_manage",
    "Manage hive-memory users. Admin-only tool — requires CORTEX_AUTH_TOKEN. Actions: add (create user + return API key), list (all users), revoke (deactivate user), rotate (rotate API key).",
    {
      action: z.enum(["add", "list", "revoke", "rotate"]).describe("Action to perform"),
      name: z.string().optional().describe("User name (required for 'add')"),
      email: z.string().optional().describe("User email (optional for 'add')"),
      user_id: z.string().optional().describe("User ID to revoke or rotate (required for 'revoke' and 'rotate')"),
    },
    async (args) => {
      // Admin authorization check — use ALS context or fallback to passed userContext
      const requestCtx = getCurrentRequestContext();
      const effectiveCtx = requestCtx.userId ? requestCtx : (userContext ?? {});
      if (effectiveCtx.userId) {
        const allUsers = listUsers(db);
        const caller = allUsers.find(u => u.id === effectiveCtx.userId);
        if (caller && caller.role !== "admin") {
          return { content: [{ type: "text" as const, text: "Error: user_manage requires admin role" }], isError: true };
        }
      }

      const action = args.action as string;

      switch (action) {
        case "add": {
          const name = args.name as string | undefined;
          if (!name) {
            return { content: [{ type: "text" as const, text: "Error: name is required for action 'add'" }], isError: true };
          }
          const email = args.email as string | undefined;
          const { user, plaintextKey } = createUser(db, name, email);
          const lines = [
            `User created.`,
            `ID:    ${user.id}`,
            `Name:  ${user.name}`,
            ...(user.email ? [`Email: ${user.email}`] : []),
            ``,
            `API key (save this — it won't be shown again):`,
            `  ${plaintextKey}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        case "list": {
          const users = listUsers(db);
          if (users.length === 0) {
            return { content: [{ type: "text" as const, text: "No users found." }] };
          }
          const rows = users.map((u) =>
            `${u.id}  ${u.name}  ${u.email ?? "—"}  ${u.status}  ${u.createdAt.slice(0, 10)}`,
          );
          const text = ["ID                                    Name            Email                        Status    Created", ...rows].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        case "revoke": {
          const userId = args.user_id as string | undefined;
          if (!userId) {
            return { content: [{ type: "text" as const, text: "Error: user_id is required for action 'revoke'" }], isError: true };
          }
          const users = listUsers(db);
          const user = users.find((u) => u.id === userId);
          if (!user) {
            return { content: [{ type: "text" as const, text: `Error: user not found: ${userId}` }], isError: true };
          }
          revokeUser(db, userId);
          return { content: [{ type: "text" as const, text: `User ${user.name} (${userId}) revoked.` }] };
        }

        case "rotate": {
          const userId = args.user_id as string | undefined;
          if (!userId) {
            return { content: [{ type: "text" as const, text: "Error: user_id is required for action 'rotate'" }], isError: true };
          }
          const users = listUsers(db);
          const user = users.find((u) => u.id === userId);
          if (!user) {
            return { content: [{ type: "text" as const, text: `Error: user not found: ${userId}` }], isError: true };
          }
          const { newKey, graceUntil } = rotateApiKey(db, userId);
          const lines = [
            `API key rotated for user ${user.name} (${userId}).`,
            ``,
            `New API key (save this — it won't be shown again):`,
            `  ${newKey}`,
            ``,
            `Grace period expires: ${graceUntil}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
      }
    },
  );
}
