import { z } from "zod";
import type { HiveDatabase } from "../db/database.js";
import { createUser, listUsers, revokeUser } from "../auth.js";
import type { SafeToolFn, GetUserContext } from "./index.js";

export function registerUserTools(safeTool: SafeToolFn, db: HiveDatabase, getUserContext?: GetUserContext) {
  safeTool(
    "user_manage",
    "Manage hive-memory users. Admin-only tool — requires CORTEX_AUTH_TOKEN. Actions: add (create user + return API key), list (all users), revoke (deactivate user).",
    {
      action: z.enum(["add", "list", "revoke"]).describe("Action to perform"),
      name: z.string().optional().describe("User name (required for 'add')"),
      email: z.string().optional().describe("User email (optional for 'add')"),
      user_id: z.string().optional().describe("User ID to revoke (required for 'revoke')"),
    },
    async (args) => {
      // Check admin authorization: system token (no userId) or user with admin role.
      const userContext = getUserContext?.();
      const isSystemToken = userContext === undefined || userContext.userId === undefined;
      if (!isSystemToken) {
        const userRecord = db.getUserById(userContext.userId!);
        if (userRecord?.role !== "admin") {
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

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
      }
    },
  );
}
