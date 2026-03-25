import { z } from "zod";
import type { CortexStore } from "../store.js";
import { TeamSync } from "../team/git-sync.js";
import type { SafeToolFn } from "./index.js";

export function registerTeamTools(safeTool: SafeToolFn, store: CortexStore) {
  // ── team_init ──

  safeTool(
    "team_init",
    "Initialize a team cortex git repository for sharing team-visibility entries across agents.",
    {
      path: z.string().describe("Absolute path where the team cortex git repo should be created or linked"),
      remote: z.string().optional().describe("Optional git remote URL (e.g. git@github.com:org/team-cortex.git)"),
    },
    async (args) => {
      const path = args.path as string;
      const remote = args.remote as string | undefined;

      const db = store.database;
      const team = new TeamSync(path, db);

      await team.init();

      if (remote) {
        await team.addRemote(remote);
      }

      store.setTeamSync(team);

      const remoteNote = remote ? `\nRemote: ${remote}` : "\nNo remote configured (local-only mode).";
      return {
        content: [{
          type: "text" as const,
          text: `Team cortex initialized at: ${path}${remoteNote}`,
        }],
      };
    },
  );

  // ── team_push ──

  safeTool(
    "team_push",
    "Push team-visibility entries from local DB to the team cortex git repo.",
    {
      entries: z.array(z.string()).optional().describe("Specific entry IDs to push (default: all team-visibility entries)"),
    },
    async (args) => {
      const entryIds = args.entries as string[] | undefined;
      const team = store.teamSync;

      if (!team) {
        return {
          content: [{
            type: "text" as const,
            text: "Team cortex is not initialized. Run team_init first.",
          }],
          isError: true,
        };
      }

      const result = await team.push(entryIds);

      return {
        content: [{
          type: "text" as const,
          text: result.pushed === 0
            ? "Nothing to push — all team entries are already up to date."
            : `Pushed ${result.pushed} entr${result.pushed === 1 ? "y" : "ies"} to team cortex.`,
        }],
      };
    },
  );

  // ── team_pull ──

  safeTool(
    "team_pull",
    "Pull entries from the team cortex git repo into the local DB.",
    {},
    async () => {
      const team = store.teamSync;

      if (!team) {
        return {
          content: [{
            type: "text" as const,
            text: "Team cortex is not initialized. Run team_init first.",
          }],
          isError: true,
        };
      }

      const result = await team.pull();

      const lines: string[] = [`Pulled ${result.pulled} entr${result.pulled === 1 ? "y" : "ies"} from team cortex.`];
      if (result.conflicts > 0) {
        lines.push(`${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} detected (both versions kept).`);
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  // ── team_status ──

  safeTool(
    "team_status",
    "Show sync status between local DB and team cortex: entries to push, entries to pull, and conflicts.",
    {},
    async () => {
      const team = store.teamSync;

      if (!team) {
        return {
          content: [{
            type: "text" as const,
            text: "Team cortex is not initialized. Run team_init first.",
          }],
          isError: true,
        };
      }

      const status = await team.status();

      const lines: string[] = ["Team Cortex Status", ""];
      lines.push(`  To push:  ${status.toPush} entr${status.toPush === 1 ? "y" : "ies"}`);
      lines.push(`  To pull:  ${status.toPull} entr${status.toPull === 1 ? "y" : "ies"}`);
      lines.push(`  Conflicts: ${status.conflicts.length}`);

      if (status.conflicts.length > 0) {
        lines.push("");
        lines.push("Conflicting IDs:");
        for (const id of status.conflicts) {
          lines.push(`  - ${id}`);
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );
}
