import { z } from "zod";
import type { HiveDatabase } from "../db/database.js";
import { listUsers } from "../auth.js";
import type { SafeToolFn, UserContext } from "./index.js";
import { getCurrentRequestContext } from "../request-context.js";

export function registerOrgTools(safeTool: SafeToolFn, db: HiveDatabase, userContext?: UserContext) {
  safeTool(
    "org_manage",
    "Manage organizations and workspaces. Admin-only tool. Actions: create (create org + workspace), list (list organizations), invite (add user to org).",
    {
      action: z.enum(["create", "list", "invite"]).describe("Action to perform"),
      name: z.string().optional().describe("Organization name (required for 'create')"),
      slug: z.string().optional().describe("Organization slug — unique identifier (required for 'create')"),
      org_slug: z.string().optional().describe("Organization slug to invite user into (required for 'invite')"),
      user_id: z.string().optional().describe("User ID to invite (required for 'invite')"),
      workspace_name: z.string().optional().describe("Default workspace name (optional for 'create', defaults to 'default')"),
      workspace_slug: z.string().optional().describe("Default workspace slug (optional for 'create', defaults to 'default')"),
    },
    async (args) => {
      // Admin authorization check
      const requestCtx = getCurrentRequestContext();
      const effectiveCtx = requestCtx.userId ? requestCtx : (userContext ?? {});
      if (effectiveCtx.userId) {
        const allUsers = listUsers(db);
        const caller = allUsers.find((u) => u.id === effectiveCtx.userId);
        if (caller && caller.role !== "admin") {
          return { content: [{ type: "text" as const, text: "Error: org_manage requires admin role" }], isError: true };
        }
      } else if (process.env.CORTEX_ACL === "on") {
        // When ACL is enabled, unauthenticated access is blocked
        return { content: [{ type: "text" as const, text: "Error: authentication required when CORTEX_ACL is enabled" }], isError: true };
      }
      // When CORTEX_ACL is off and no userId: allow (single-user/dev mode)

      const action = args.action as string;

      switch (action) {
        case "create": {
          const name = args.name as string | undefined;
          const slug = args.slug as string | undefined;
          if (!name || !slug) {
            return { content: [{ type: "text" as const, text: "Error: name and slug are required for action 'create'" }], isError: true };
          }
          const workspaceName = (args.workspace_name as string | undefined) ?? "default";
          const workspaceSlug = (args.workspace_slug as string | undefined) ?? "default";

          const org = db.createOrganization(name, slug);
          const workspace = db.createWorkspace(org.id, workspaceName, workspaceSlug);

          const lines = [
            `Organization created.`,
            `  ID:   ${org.id}`,
            `  Name: ${org.name}`,
            `  Slug: ${org.slug}`,
            ``,
            `Default workspace created.`,
            `  ID:   ${workspace.id}`,
            `  Name: ${workspace.name}`,
            `  Slug: ${workspace.slug}`,
          ];
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        }

        case "list": {
          const orgs = db.listOrganizations();
          if (orgs.length === 0) {
            return { content: [{ type: "text" as const, text: "No organizations found." }] };
          }
          const rows = orgs.map((o) => {
            const workspaces = db.listWorkspaces(o.id);
            const wsList = workspaces.map((w) => `    workspace: ${w.slug} (${w.id})`).join("\n");
            return `${o.id}  ${o.name}  [${o.slug}]  ${o.status}\n${wsList}`;
          });
          const text = ["ID                                    Name            Slug       Status", ...rows].join("\n");
          return { content: [{ type: "text" as const, text }] };
        }

        case "invite": {
          const orgSlug = args.org_slug as string | undefined;
          const userId = args.user_id as string | undefined;
          if (!orgSlug || !userId) {
            return { content: [{ type: "text" as const, text: "Error: org_slug and user_id are required for action 'invite'" }], isError: true };
          }

          const org = db.getOrganizationBySlug(orgSlug);
          if (!org) {
            return { content: [{ type: "text" as const, text: `Error: organization not found: ${orgSlug}` }], isError: true };
          }

          const allUsers = listUsers(db);
          const user = allUsers.find((u) => u.id === userId);
          if (!user) {
            return { content: [{ type: "text" as const, text: `Error: user not found: ${userId}` }], isError: true };
          }

          // Get the default workspace for this org
          const workspaces = db.listWorkspaces(org.id);
          const defaultWorkspace = workspaces[0];

          db.assignUserToOrg(userId, org.id, defaultWorkspace?.id);

          const wsInfo = defaultWorkspace ? ` (workspace: ${defaultWorkspace.slug})` : "";
          return { content: [{ type: "text" as const, text: `User ${user.name} (${userId}) added to organization ${org.name} (${orgSlug})${wsInfo}.` }] };
        }

        default:
          return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }], isError: true };
      }
    },
  );
}
