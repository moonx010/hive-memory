import { z } from "zod";
import { HiveDatabase } from "../db/database.js";
import type { SafeToolFn } from "./index.js";

// ── Helpers ──

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(iso);
}

export function registerConnectorTools(safeTool: SafeToolFn, db: HiveDatabase) {
  // ── connector_sync ──

  safeTool(
    "connector_sync",
    "Trigger a connector sync. Use full=true to force a full sync instead of incremental.",
    {
      connector: z
        .string()
        .describe('Connector ID to sync (e.g. "github", "slack", "notion", "jira")'),
      full: z
        .boolean()
        .optional()
        .describe("Force full sync instead of incremental (default false)"),
    },
    async (args) => {
      const connectorId = args.connector as string;
      const full = (args.full as boolean | undefined) ?? false;

      const connector = db.getConnector(connectorId);

      const lines: string[] = [
        `Connector sync triggered: ${connectorId}`,
        `Mode: ${full ? "full" : "incremental"}`,
        ``,
      ];

      if (!connector) {
        lines.push(`Connector "${connectorId}" not found.`);
      } else {
        const phase = connector.syncPhase ?? "initial";
        lines.push(`Status: ${connector.status}  |  Phase: ${phase}  |  Last sync: ${connector.lastSync ? relativeTime(connector.lastSync) : "never"}`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  // ── connector_status ──

  safeTool(
    "connector_status",
    "Show the status of all configured connectors including last sync time and entry counts.",
    {},
    async (_args) => {
      const connectors = db.listConnectors();

      if (connectors.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No connectors configured.\n\nConnectors integrate external data sources (GitHub, Slack, Notion, Jira) into the memory store.",
            },
          ],
        };
      }

      const statusIcons: Record<string, string> = {
        idle: "[ ]",
        syncing: "[~]",
        error: "[!]",
      };

      const lines: string[] = [
        `Connectors (${connectors.length})`,
        ``,
      ];

      for (const c of connectors) {
        const icon = statusIcons[c.status] ?? "[ ]";
        const lastSyncStr = c.lastSync ? relativeTime(c.lastSync) : "never";
        const entryCount = db.countEntities({ namespace: c.id });
        const phase = c.syncPhase ?? "initial";

        lines.push(`${icon} ${c.id}  (${c.connectorType})`);
        lines.push(`    Status: ${c.status}  |  Phase: ${phase}  |  Last sync: ${lastSyncStr}  |  Entries: ${entryCount}`);
        lines.push(``);
      }

      const totalEntries = connectors.reduce((sum, c) => sum + db.countEntities({ namespace: c.id }), 0);
      const activeCount = connectors.filter((c) => c.status === "idle" || c.status === "syncing").length;
      const errorCount = connectors.filter((c) => c.status === "error").length;

      lines.push(`─────────────────────────────────────────`);
      lines.push(`Total: ${connectors.length} connector(s), ${activeCount} active, ${errorCount} error(s), ${totalEntries} entries`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
