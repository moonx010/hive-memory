import { z } from "zod";
import { HiveDatabase } from "../db/database.js";
import { CheckpointManager } from "../connectors/checkpoint.js";
import type { CortexStore } from "../store.js";
import type { SafeToolFn } from "./index.js";
import { ConnectorMarketplace, BUILT_IN_CONNECTORS } from "../connectors/marketplace.js";

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

export function registerConnectorTools(safeTool: SafeToolFn, db: HiveDatabase, store?: CortexStore) {
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

      if (store) {
        try {
          const result = await store.syncConnector(connectorId, full);
          const lines = [
            `Sync complete: ${connectorId}`,
            `Added: ${result.added}  |  Updated: ${result.updated}  |  Skipped: ${result.skipped}  |  Errors: ${result.errors}`,
          ];
          if (result.lastError) lines.push(`Last error: ${result.lastError}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") }] };
        } catch (err) {
          return { content: [{ type: "text" as const, text: `Sync failed: ${err instanceof Error ? err.message : err}` }], isError: true };
        }
      }

      // Fallback: just show status if store not available
      const connector = db.getConnector(connectorId);
      const lines: string[] = [`Connector: ${connectorId}`];
      if (!connector) {
        lines.push(`Not found. Available connectors depend on environment variables.`);
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

        const cursorStr = c.syncCursor ? `  |  Cursor: ${c.syncCursor}` : "";
        lines.push(`${icon} ${c.id}  (${c.connectorType})`);
        lines.push(`    Status: ${c.status}  |  Phase: ${phase}  |  Last sync: ${lastSyncStr}  |  Entries: ${entryCount}${cursorStr}`);

        // Show checkpoint progress if a resumable checkpoint exists
        const cpManager = new CheckpointManager(c.id);
        const cp = cpManager.load();
        if (cp) {
          const progress = cpManager.getProgress();
          if (progress) {
            lines.push(`    [Resumable] Checkpoint: ${progress.totalProcessed} processed  |  ${progress.streams} stream(s)  |  Last: ${relativeTime(progress.lastCheckpoint)}`);
          }
        }

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

  // ── connector_marketplace ──

  safeTool(
    "connector_marketplace",
    "List all available connectors with their configuration status",
    {},
    async (_args) => {
      const marketplace = new ConnectorMarketplace();
      for (const manifest of BUILT_IN_CONNECTORS) {
        marketplace.register(manifest);
      }

      const all = marketplace.list();
      const configured = all.filter(c => c.configured);
      const unconfigured = all.filter(c => !c.configured);

      const lines: string[] = [
        `Connector Marketplace (${all.length} available)`,
        ``,
      ];

      if (configured.length > 0) {
        lines.push(`Configured (${configured.length}):`);
        for (const c of configured) {
          lines.push(`  [✓] ${c.name} (${c.id}) — ${c.description}`);
        }
        lines.push(``);
      }

      if (unconfigured.length > 0) {
        lines.push(`Not configured (${unconfigured.length}):`);
        for (const c of unconfigured) {
          lines.push(`  [✗] ${c.name} (${c.id}) — ${c.description}`);
          lines.push(`      Required env: ${c.requiredEnvVars.join(", ")}`);
        }
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
