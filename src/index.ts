#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CortexStore } from "./store.js";
import { registerTools } from "./tools.js";
import { handleCli } from "./cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const DATA_DIR =
  process.env["CORTEX_DATA_DIR"] ?? join(homedir(), ".cortex");
const SYNC_LOCAL = process.env["CORTEX_LOCAL_SYNC"] !== "false";

/**
 * Register all available connectors that have valid credentials.
 * Connectors are configured via environment variables.
 */
function registerConnectors(store: CortexStore): void {
  const registry = store.connectors;

  // GitHub connector
  if (process.env["GITHUB_TOKEN"]) {
    import("./connectors/github.js").then(({ GitHubConnector }) => {
      registry.register(new GitHubConnector());
    }).catch(() => {});
  }

  // Slack connector
  if (process.env["SLACK_TOKEN"]) {
    import("./connectors/slack.js").then(({ SlackConnector }) => {
      registry.register(new SlackConnector());
    }).catch(() => {});
  }

  // Notion connector
  if (process.env["NOTION_TOKEN"]) {
    import("./connectors/notion.js").then(({ NotionConnector }) => {
      registry.register(new NotionConnector());
    }).catch(() => {});
  }

  // Google Calendar connector
  if (process.env["GOOGLE_CALENDAR_CREDENTIALS"]) {
    import("./connectors/calendar.js").then(({ CalendarConnector }) => {
      registry.register(new CalendarConnector());
    }).catch(() => {});
  }
}

function createStore(): CortexStore {
  return new CortexStore({
    dataDir: DATA_DIR,
    localContext: {
      filename: process.env["CORTEX_LOCAL_FILENAME"] ?? ".cortex.md",
      enabled: SYNC_LOCAL,
    },
  });
}

// --- CLI hook routing ---

async function handleHook(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (subcommand === "session-end") {
    const { handleSessionEnd } = await import("./hooks/session-end.js");
    await handleSessionEnd(createStore(), args.slice(1));
  } else {
    console.error(`Unknown hook subcommand: ${subcommand}`);
    process.exit(1);
  }
}

// --- CLI commands ---

const CLI_COMMANDS = new Set(["store", "recall", "status", "inject", "sync", "cleanup", "stats", "team"]);

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  // CLI mode: hive-memory hook <subcommand> [args...]
  if (args[0] === "hook") {
    await handleHook(args.slice(1));
    return;
  }

  // CLI mode: hive-memory stats
  if (args[0] === "stats") {
    const store = createStore();
    await store.init();
    await handleStats(store);
    return;
  }

  // CLI mode: hive-memory team <subcommand> [args...]
  if (args[0] === "team") {
    const store = createStore();
    await store.init();
    await handleTeamCli(store, args.slice(1));
    return;
  }

  // CLI mode: hive-memory sync <connector>
  if (args[0] === "sync" && args[1] && !args[1].startsWith("--")) {
    const store = createStore();
    await store.init();
    registerConnectors(store);
    // Wait a tick for dynamic imports to resolve
    await new Promise(r => setTimeout(r, 100));
    await handleConnectorSync(store, args[1]);
    return;
  }

  // CLI mode: hive-memory <command> [args...]
  if (args[0] && CLI_COMMANDS.has(args[0])) {
    const store = createStore();
    const initStore = async () => {
      await store.init();
    };
    await handleCli(store, initStore, args);
    return;
  }

  // Default: MCP server mode
  const store = createStore();
  await store.init();
  registerConnectors(store);

  const server = new McpServer({
    name: "cortex",
    version: pkg.version as string,
  });

  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── stats command ──

async function handleStats(store: CortexStore): Promise<void> {
  const index = await store.getIndex();
  const db = store.database;

  const total = db.countEntities({});
  const connectors = db.listConnectors();

  console.log("Hive Memory — Database Statistics");
  console.log("==================================");
  console.log(`Projects:  ${index.projects.length}`);
  console.log(`Entities:  ${total}`);

  if (connectors.length > 0) {
    console.log(`\nConnectors (${connectors.length}):`);
    for (const c of connectors) {
      const lastSync = c.lastSync ? c.lastSync.slice(0, 10) : "never";
      const entryCount = db.countEntities({ namespace: c.id });
      console.log(`  ${c.id} — ${c.status} — ${entryCount} entries (last sync: ${lastSync})`);
    }
  }

  const synapseStats = await store.getSynapseStats();
  console.log(`\nSynapses:  ${synapseStats.totalSynapses} (avg weight: ${synapseStats.avgWeight.toFixed(3)})`);
}

// ── team command ──

async function handleTeamCli(store: CortexStore, args: string[]): Promise<void> {
  const subcommand = args[0];

  switch (subcommand) {
    case "init": {
      const path = args[1];
      if (!path) {
        console.error("Usage: hive-memory team init <path> [--remote <url>]");
        process.exit(1);
      }
      const remoteIdx = args.indexOf("--remote");
      const remote = remoteIdx !== -1 ? args[remoteIdx + 1] : undefined;

      const { TeamSync } = await import("./team/git-sync.js");
      const db = store.database;
      const team = new TeamSync(path, db);
      await team.init();
      if (remote) {
        await team.addRemote(remote);
      }
      store.setTeamSync(team);
      console.log(`Team cortex initialized at: ${path}`);
      if (remote) console.log(`Remote: ${remote}`);
      break;
    }

    case "push": {
      const team = store.teamSync;
      if (!team) {
        console.error("Team cortex not initialized. Run: hive-memory team init <path>");
        process.exit(1);
      }
      const result = await team.push();
      console.log(
        result.pushed === 0
          ? "Nothing to push — all team entries are already up to date."
          : `Pushed ${result.pushed} entr${result.pushed === 1 ? "y" : "ies"} to team cortex.`,
      );
      break;
    }

    case "pull": {
      const team = store.teamSync;
      if (!team) {
        console.error("Team cortex not initialized. Run: hive-memory team init <path>");
        process.exit(1);
      }
      const result = await team.pull();
      console.log(`Pulled ${result.pulled} entr${result.pulled === 1 ? "y" : "ies"} from team cortex.`);
      if (result.conflicts > 0) {
        console.log(`${result.conflicts} conflict${result.conflicts === 1 ? "" : "s"} detected (both versions kept).`);
      }
      break;
    }

    case "status": {
      const team = store.teamSync;
      if (!team) {
        console.error("Team cortex not initialized. Run: hive-memory team init <path>");
        process.exit(1);
      }
      const status = await team.status();
      console.log("Team Cortex Status");
      console.log("==================");
      console.log(`  To push:   ${status.toPush}`);
      console.log(`  To pull:   ${status.toPull}`);
      console.log(`  Conflicts: ${status.conflicts.length}`);
      if (status.conflicts.length > 0) {
        console.log("\nConflicting IDs:");
        for (const id of status.conflicts) {
          console.log(`  - ${id}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown team subcommand: ${subcommand ?? "(none)"}`);
      console.error("Available: team init <path>, team push, team pull, team status");
      process.exit(1);
  }
}

// ── connector sync command ──

async function handleConnectorSync(store: CortexStore, connectorId: string): Promise<void> {
  console.log(`Syncing connector: ${connectorId}...`);
  try {
    const result = await store.syncConnector(connectorId);
    console.log(`Sync complete — added: ${result.added}, updated: ${result.updated}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Connector sync failed: ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Cortex failed to start:", err);
  process.exit(1);
});
