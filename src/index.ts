#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CortexStore } from "./store.js";
import { registerTools } from "./tools.js";
import { handleCli } from "./cli.js";
import { resolveAuth } from "./auth.js";
import { verifySlackSignature, handleSlackEvent } from "./bot/slack-bot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const DATA_DIR =
  process.env["CORTEX_DATA_DIR"] ?? join(homedir(), ".cortex");
const SYNC_LOCAL = process.env["CORTEX_LOCAL_SYNC"] !== "false";

/**
 * Register all available connectors that have valid credentials.
 * Connectors are configured via environment variables.
 */
async function registerConnectors(store: CortexStore): Promise<void> {
  const registry = store.connectors;
  const imports: Promise<void>[] = [];

  if (process.env["GITHUB_TOKEN"]) {
    imports.push(
      import("./connectors/github.js")
        .then(({ GitHubConnector }) => { registry.register(new GitHubConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load GitHub connector: ${err?.message ?? err}`); }),
    );
  }

  if (process.env["SLACK_TOKEN"]) {
    imports.push(
      import("./connectors/slack.js")
        .then(({ SlackConnector }) => { registry.register(new SlackConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load Slack connector: ${err?.message ?? err}`); }),
    );
  }

  if (process.env["NOTION_TOKEN"]) {
    imports.push(
      import("./connectors/notion.js")
        .then(({ NotionConnector }) => { registry.register(new NotionConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load Notion connector: ${err?.message ?? err}`); }),
    );
  }

  if (process.env["GOOGLE_CALENDAR_CREDENTIALS"]) {
    imports.push(
      import("./connectors/calendar.js")
        .then(({ CalendarConnector }) => { registry.register(new CalendarConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load Calendar connector: ${err?.message ?? err}`); }),
    );
  }

  if (process.env["OUTLOOK_TOKEN"]) {
    imports.push(
      import("./connectors/outlook.js")
        .then(({ OutlookConnector }) => { registry.register(new OutlookConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load Outlook connector: ${err?.message ?? err}`); }),
    );
  }

  await Promise.allSettled(imports);
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

const CLI_COMMANDS = new Set(["store", "recall", "status", "inject", "sync", "cleanup", "stats", "team", "enrich", "meeting", "transcribe", "audit", "briefing", "analyze", "patterns", "connect", "user"]);

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  // HTTP server mode
  if (process.env["CORTEX_HTTP"] === "true" || args.includes("--http")) {
    const port = parseInt(process.env["CORTEX_PORT"] ?? "3179", 10);
    const authToken = process.env["CORTEX_AUTH_TOKEN"];

    const store = createStore();
    await store.init();
    await registerConnectors(store);

    const server = new McpServer({
      name: "cortex",
      version: pkg.version as string,
    });

    // Mutable context updated per-request before tool handlers are invoked.
    const userContext = { userId: undefined as string | undefined, userName: undefined as string | undefined };
    registerTools(server, store, userContext);

    const slackBotEnabled = process.env["SLACK_BOT_ENABLED"] === "true";
    const slackSigningSecret = process.env["SLACK_SIGNING_SECRET"] ?? "";
    const slackToken = process.env["SLACK_TOKEN"] ?? "";

    const httpServer = createServer(async (req, res) => {
      // ── Slack Events API route ──────────────────────────────────────────────
      if (slackBotEnabled && req.url === "/slack/events" && req.method === "POST") {
        // Collect body bytes (needed for signature verification)
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();

        // Parse payload
        let payload: { type?: string; challenge?: string; event?: unknown };
        try {
          payload = JSON.parse(body) as typeof payload;
        } catch {
          res.writeHead(400);
          res.end("Bad Request");
          return;
        }

        // URL verification challenge (no signature required — Slack sends this during setup)
        if (payload.type === "url_verification") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: payload.challenge }));
          return;
        }

        // Verify Slack signature
        const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
        const signature = req.headers["x-slack-signature"] as string | undefined;

        if (!timestamp || !signature || !verifySlackSignature(slackSigningSecret, timestamp, body, signature)) {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }

        // Ack immediately — Slack requires a response within 3 seconds
        res.writeHead(200);
        res.end();

        // Process event asynchronously (after ack)
        handleSlackEvent(
          payload as Parameters<typeof handleSlackEvent>[0],
          store,
          slackToken,
        ).catch((err: unknown) => {
          console.error("[bumble-bee] Event handling error:", err);
        });

        return;
      }

      // ── MCP route (default) ─────────────────────────────────────────────────
      const { authorized, userId, userName } = resolveAuth(store.database, req.headers.authorization, authToken);
      if (!authorized) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      // Update shared context for this request's tool handlers.
      userContext.userId = userId;
      userContext.userName = userName;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    });

    httpServer.listen(port, () => {
      console.error(`[cortex] HTTP MCP server listening on port ${port}`);
    });

    return;
  }

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

  // CLI mode: hive-memory user <subcommand> [args...]
  if (args[0] === "user") {
    const store = createStore();
    await store.init();
    await handleUserCli(store, args.slice(1));
    return;
  }

  // CLI mode: hive-memory sync <connector>
  if (args[0] === "sync" && args[1] && !args[1].startsWith("--")) {
    const store = createStore();
    await store.init();
    await registerConnectors(store);
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
  await registerConnectors(store);

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

// ── user command ──

async function handleUserCli(store: CortexStore, args: string[]): Promise<void> {
  const { createUser, listUsers, revokeUser } = await import("./auth.js");
  const db = store.database;
  const subcommand = args[0];

  switch (subcommand) {
    case "create": {
      const name = args[1];
      if (!name) {
        console.error("Usage: hive-memory user create <name> [--email <email>]");
        process.exit(1);
      }
      const emailIdx = args.indexOf("--email");
      const email = emailIdx !== -1 ? args[emailIdx + 1] : undefined;
      const { user, plaintextKey } = createUser(db, name, email);
      console.log(`User created.`);
      console.log(`  ID:    ${user.id}`);
      console.log(`  Name:  ${user.name}`);
      if (user.email) console.log(`  Email: ${user.email}`);
      console.log(`\nAPI key (save this — it won't be shown again):`);
      console.log(`  ${plaintextKey}`);
      break;
    }

    case "list": {
      const users = listUsers(db);
      if (users.length === 0) {
        console.log("No users found.");
        break;
      }
      const header = "ID                                    Name            Email                        Status   Created";
      console.log(header);
      console.log("-".repeat(header.length));
      for (const u of users) {
        const id = u.id.padEnd(36);
        const name = u.name.padEnd(15);
        const email = (u.email ?? "").padEnd(28);
        const status = u.status.padEnd(8);
        const created = u.createdAt.slice(0, 10);
        console.log(`${id}  ${name}  ${email}  ${status}  ${created}`);
      }
      break;
    }

    case "revoke": {
      const userId = args[1];
      if (!userId) {
        console.error("Usage: hive-memory user revoke <user-id>");
        process.exit(1);
      }
      const users = listUsers(db);
      const user = users.find((u) => u.id === userId);
      if (!user) {
        console.error(`User not found: ${userId}`);
        process.exit(1);
      }
      revokeUser(db, userId);
      console.log(`User ${user.name} (${userId}) revoked.`);
      break;
    }

    default:
      console.error(`Unknown user subcommand: ${subcommand ?? "(none)"}`);
      console.error("Available: user create <name> [--email <email>], user list, user revoke <id>");
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
