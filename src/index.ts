#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CortexStore } from "./store.js";
import { registerTools } from "./tools.js";
import { handleCli } from "./cli.js";
import { resolveAuth } from "./auth.js";
import { recordRequest, recordSync, getMetrics } from "./observability/metrics.js";
import { checkRateLimit } from "./observability/rate-limit.js";
import { requestContext } from "./request-context.js";
import { initAuditDb } from "./observability/audit.js";

// Re-export getCurrentRequestContext for consumers
export { getCurrentRequestContext } from "./request-context.js";

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

  if (process.env["RECALL_API_KEY"]) {
    imports.push(
      import("./connectors/recall.js")
        .then(({ RecallConnector }) => { registry.register(new RecallConnector()); })
        .catch((err) => { console.error(`[cortex] Failed to load Recall connector: ${err?.message ?? err}`); }),
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

const CLI_COMMANDS = new Set(["store", "recall", "status", "inject", "sync", "cleanup", "stats", "team", "enrich", "meeting", "transcribe", "audit", "audit-log", "briefing", "analyze", "patterns", "connect", "user", "org", "backup", "import-slack", "lifecycle"]);

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  // HTTP server mode
  if (process.env["CORTEX_HTTP"] === "true" || args.includes("--http")) {
    const port = parseInt(process.env["PORT"] ?? process.env["CORTEX_PORT"] ?? "3179", 10);
    const authToken = process.env["CORTEX_AUTH_TOKEN"];

    const store = createStore();
    await store.init();
    initAuditDb(store.database);
    await registerConnectors(store);

    // McpServer is created per-request because the SDK only allows
    // one transport per server instance. Tools are registered fresh
    // each time but share the same store/db (thread-safe via SQLite WAL).
    function createMcpServer() {
      const srv = new McpServer({
        name: "cortex",
        version: pkg.version as string,
      });
      registerTools(srv, store);
      return srv;
    }

    // Slack signing secret for message ingestion webhook verification
    const slackSigningSecret = process.env["SLACK_SIGNING_SECRET"] ?? "";

    const httpServer = createServer(async (req, res) => {
      // ── Health check ─────────────────────────────────────────────────────────
      if (req.url === "/health" && req.method === "GET") {
        try {
          store.database.countEntities({});
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", version: pkg.version }));
        } catch {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "error" }));
        }
        return;
      }

      // ── Metrics endpoint (auth required) ─────────────────────────────────────
      if (req.url === "/metrics" && req.method === "GET") {
        if (authToken) {
          const provided = req.headers.authorization?.replace("Bearer ", "");
          if (provided !== authToken) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(getMetrics()));
        return;
      }

      // ── Dashboard (HTML shell served without auth — API calls require token) ─
      if (req.url === "/dashboard" && req.method === "GET") {
        const { DASHBOARD_HTML } = await import("./dashboard/html.js");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      // ── Dashboard API ──────────────────────────────────────────────────────────
      if (req.url?.startsWith("/api/") && req.method === "GET") {
        const { authorized: apiAuth } = resolveAuth(store.database, req.headers.authorization, authToken);
        if (!apiAuth) { res.writeHead(401); res.end("Unauthorized"); return; }
        const { handleApiRequest } = await import("./dashboard/api.js");
        const url = new URL(req.url, `http://localhost:${port}`);
        try {
          const result = handleApiRequest(store.database, url.pathname, url.searchParams);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
        return;
      }

      // ── Gateway status endpoint (auth required) ─────────────────────────────
      if (req.url === "/gateway/status" && req.method === "GET") {
        if (authToken) {
          const provided = req.headers.authorization?.replace("Bearer ", "");
          if (provided !== authToken) {
            res.writeHead(401);
            res.end("Unauthorized");
            return;
          }
        }
        const { loadGatewayConfig } = await import("./gateway/mcp-gateway.js");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(loadGatewayConfig()));
        return;
      }

      // ── Slack Events API route (message ingestion only — bot extracted to jarvis) ──
      if (slackSigningSecret && req.url === "/slack/events" && req.method === "POST") {
        // Collect body bytes — limit to 1MB
        const MAX_BODY_SIZE = 1_048_576;
        const chunks: Buffer[] = [];
        let totalSize = 0;
        let oversized = false;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_BODY_SIZE) { oversized = true; break; }
          chunks.push(chunk as Buffer);
        }
        if (oversized) {
          res.writeHead(413);
          res.end("Payload Too Large");
          return;
        }
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

        // URL verification challenge
        if (payload.type === "url_verification") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ challenge: payload.challenge }));
          return;
        }

        // Verify Slack signature (inline — no bot import needed)
        const timestamp = req.headers["x-slack-request-timestamp"] as string | undefined;
        const signature = req.headers["x-slack-signature"] as string | undefined;

        if (!timestamp || !signature) {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        if (Math.abs(now - parseInt(timestamp, 10)) > 300) {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }
        const { createHmac, timingSafeEqual } = await import("node:crypto");
        const basestring = `v0:${timestamp}:${body}`;
        const computed = `v0=${createHmac("sha256", slackSigningSecret).update(basestring).digest("hex")}`;
        try {
          if (!timingSafeEqual(Buffer.from(computed), Buffer.from(signature))) {
            res.writeHead(401);
            res.end("Invalid signature");
            return;
          }
        } catch {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }

        // Ack immediately
        res.writeHead(200);
        res.end();

        // Ingest message events into hive-memory (memory layer — no bot handling)
        if ((payload as { event?: { type?: string } }).event?.type === "message") {
          import("./connectors/slack-webhook.js")
            .then(({ processSlackMessageEvent }) => {
              const result = processSlackMessageEvent(
                store.database,
                (payload as { event: Parameters<typeof processSlackMessageEvent>[1] }).event,
              );
              if (result.stored) {
                console.error(`[slack-webhook] Stored message ${result.entityId}`);
              }
            })
            .catch((err: unknown) => {
              console.error("[slack-webhook] Message ingestion error:", err);
            });
        }

        return;
      }

      // ── Recall.ai webhook route ─────────────────────────────────────────────
      if (req.url === "/recall/events" && req.method === "POST") {
        const recallSecret = process.env["RECALL_WEBHOOK_SECRET"];
        if (!recallSecret) {
          res.writeHead(403);
          res.end("Recall webhook not configured");
          return;
        }

        const MAX_BODY_SIZE = 1_048_576;
        const chunks: Buffer[] = [];
        let totalSize = 0;
        let oversized = false;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_BODY_SIZE) { oversized = true; break; }
          chunks.push(chunk as Buffer);
        }
        if (oversized) {
          res.writeHead(413);
          res.end("Payload Too Large");
          return;
        }
        const body = Buffer.concat(chunks).toString();

        // Svix signature verification
        const svixId = req.headers["svix-id"] as string | undefined;
        const svixTimestamp = req.headers["svix-timestamp"] as string | undefined;
        const svixSignature = req.headers["svix-signature"] as string | undefined;
        if (!svixId || !svixTimestamp || !svixSignature) {
          res.writeHead(401);
          res.end("Missing signature headers");
          return;
        }
        const { createHmac: hmac } = await import("node:crypto");
        const signedContent = `${svixId}.${svixTimestamp}.${body}`;
        const secret = Buffer.from(recallSecret.replace("whsec_", ""), "base64");
        const computed = hmac("sha256", secret).update(signedContent).digest("base64");
        const signatures = svixSignature.split(" ").map((s: string) => s.split(",")[1] ?? "");
        if (!signatures.includes(computed)) {
          res.writeHead(401);
          res.end("Invalid signature");
          return;
        }

        let payload: { event?: string; data?: unknown };
        try {
          payload = JSON.parse(body) as typeof payload;
        } catch {
          res.writeHead(400);
          res.end("Bad Request");
          return;
        }

        // Ack immediately
        res.writeHead(200);
        res.end();

        // Process async
        import("./connectors/recall.js")
          .then(async ({ handleRecallWebhook }) => {
            await handleRecallWebhook(payload, store);
          })
          .catch((err: unknown) => {
            console.error("[recall] Webhook handling error:", err);
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

      // ── Rate limiting ────────────────────────────────────────────────────────
      const rateLimitKey = userId ?? req.socket.remoteAddress ?? "anonymous";
      if (!checkRateLimit(rateLimitKey)) {
        res.writeHead(429, { "Content-Type": "text/plain" });
        res.end("Too Many Requests");
        return;
      }

      const requestStart = Date.now();
      let requestError = false;
      res.on("close", () => {
        recordRequest(Date.now() - requestStart, requestError);
      });

      await requestContext.run({ userId, userName }, async () => {
        try {
          const perRequestServer = createMcpServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on("close", () => { transport.close(); });
          await perRequestServer.connect(transport);
          await transport.handleRequest(req, res);
        } catch (err) {
          requestError = true;
          throw err;
        }
      });
    });

    httpServer.listen(port, () => {
      console.error(`[cortex] HTTP MCP server listening on port ${port}`);
    });

    setupGracefulShutdown(httpServer, store);

    // ── Auto-sync scheduler ───────────────────────────────────────────
    const syncIntervalMs = parseInt(process.env["CORTEX_SYNC_INTERVAL_MIN"] ?? "30", 10) * 60 * 1000;
    if (syncIntervalMs > 0) {
      const runAutoSync = async () => {
        for (const connector of store.connectors.list()) {
          if (!connector.isConfigured()) continue;
          try {
            const result = await store.syncConnector(connector.id);
            recordSync(connector.id, true);
            console.error(`[auto-sync] ${connector.id}: +${result.added} updated=${result.updated} errors=${result.errors}`);
          } catch (err) {
            recordSync(connector.id, false);
            console.error(`[auto-sync] ${connector.id} failed: ${err}`);
          }
        }
        // Enrichment
        try {
          const enrichResult = await store.enrichBatch({ limit: 200, unenrichedOnly: true });
          if (enrichResult.enriched > 0) {
            console.error(`[auto-sync] enriched ${enrichResult.enriched}/${enrichResult.processed}`);
          }
        } catch (err) {
          console.error(`[auto-sync] enrichment failed: ${err}`);
        }

        // Daily compaction (auto-link, merge dupes, prune weak edges)
        try {
          const { runCompaction } = await import("./pipeline/compaction.js");
          const compactResult = runCompaction(store.database, { dryRun: false });
          const { linksCreated, duplicatesMerged, edgesPruned, entitiesArchived, orphansRemoved } = compactResult;
          if (linksCreated + duplicatesMerged + edgesPruned + entitiesArchived + orphansRemoved > 0) {
            console.error(`[auto-compact] links=${linksCreated} merged=${duplicatesMerged} pruned=${edgesPruned} archived=${entitiesArchived} orphans=${orphansRemoved} (${compactResult.duration}ms)`);
          }
        } catch (err) {
          console.error(`[auto-compact] Compaction failed: ${err}`);
        }

        // Daily backup (check if last backup was >24h ago)
        const backupDir = process.env.CORTEX_BACKUP_DIR ?? join(process.env.CORTEX_DATA_DIR ?? "", "backups");
        try {
          mkdirSync(backupDir, { recursive: true });

          // Check if we already backed up today
          const today = new Date().toISOString().split("T")[0];
          const files = existsSync(backupDir) ? readdirSync(backupDir) : [];
          const todayBackup = files.find(f => f.includes(today));

          if (!todayBackup) {
            const backupPath = join(backupDir, `cortex-${today}.db`);
            store.database.backup(backupPath);
            console.error(`[auto-backup] Database backed up to ${backupPath}`);

            // Keep only last 7 backups
            const sorted = files.filter(f => f.endsWith(".db")).sort().reverse();
            for (const old of sorted.slice(7)) {
              try { unlinkSync(join(backupDir, old)); } catch { /* ignore */ }
            }
          }
        } catch (err) {
          console.error(`[auto-backup] Backup failed: ${err}`);
        }
      };

      // First sync after 10s startup delay
      setTimeout(() => {
        runAutoSync().catch((err) => console.error(`[auto-sync] initial sync failed: ${err}`));
      }, 10_000);

      // Then every CORTEX_SYNC_INTERVAL_MIN minutes
      setInterval(() => {
        runAutoSync().catch((err) => console.error(`[auto-sync] periodic sync failed: ${err}`));
      }, syncIntervalMs);

      console.error(`[cortex] Auto-sync enabled: every ${syncIntervalMs / 60000} min`);
    }

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
  initAuditDb(store.database);

  // Log hybrid search mode at startup
  if (!process.env.CORTEX_EMBEDDING_PROVIDER || process.env.CORTEX_EMBEDDING_PROVIDER === "none") {
    console.error("[cortex] Hybrid search: BM25 only (set CORTEX_EMBEDDING_PROVIDER=local for vector search)");
  } else {
    console.error(`[cortex] Hybrid search: BM25 + vector (${process.env.CORTEX_EMBEDDING_PROVIDER})`);
  }

  await registerConnectors(store);

  const server = new McpServer({
    name: "cortex",
    version: pkg.version as string,
  });

  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown for stdio mode
  const shutdownStdio = () => {
    try { store.database.close(); } catch { /* already closed */ }
    process.exit(0);
  };
  process.on("SIGTERM", shutdownStdio);
  process.on("SIGINT", shutdownStdio);
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
  const { createUser, listUsers, revokeUser, rotateApiKey } = await import("./auth.js");
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

    case "rotate": {
      const userId = args[1];
      if (!userId) {
        console.error("Usage: hive-memory user rotate <user-id>");
        process.exit(1);
      }
      const users = listUsers(db);
      const user = users.find((u) => u.id === userId);
      if (!user) {
        console.error(`User not found: ${userId}`);
        process.exit(1);
      }
      const { newKey } = rotateApiKey(db, userId);
      console.log(`API key rotated for user ${user.name} (${userId}).`);
      console.log(`\nNew API key (save this — it won't be shown again):`);
      console.log(`  ${newKey}`);
      console.log(`\nNote: The old key is revoked immediately.`);
      break;
    }

    default:
      console.error(`Unknown user subcommand: ${subcommand ?? "(none)"}`);
      console.error("Available: user create <name> [--email <email>], user list, user revoke <id>, user rotate <id>");
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

// ── Graceful shutdown ────────────────────────────────────────────────────
function setupGracefulShutdown(httpServer: import("node:http").Server, store: CortexStore) {
  const shutdown = (signal: string) => {
    console.error(`[cortex] ${signal} received, shutting down gracefully...`);
    httpServer.close(() => {
      console.error("[cortex] HTTP server closed");
      try { store.database.close(); } catch { /* already closed */ }
      console.error("[cortex] Database closed");
      process.exit(0);
    });
    // Force exit after 10s if graceful shutdown hangs
    setTimeout(() => { console.error("[cortex] Forced exit"); process.exit(1); }, 10000);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
