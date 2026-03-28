import { appendFile, writeFile } from "node:fs/promises";
import type { CortexStore } from "./store.js";
import type { MemoryCategory } from "./types.js";
import { validateId } from "./store/io.js";
import { MeetingAgent } from "./meeting/agent.js";
import { MemorySteward } from "./steward/index.js";
import { WorkflowAdvisor } from "./advisor/index.js";
import { PatternAnalyzer } from "./advisor/patterns.js";
import { transcribeToVTT } from "./meeting/stt.js";
import { ConnectorMarketplace, BUILT_IN_CONNECTORS } from "./connectors/marketplace.js";

interface CliArgs {
  command: string;
  project?: string;
  category?: string;
  agent?: string;
  query?: string;
  limit?: number;
  output?: string;
  json?: boolean;
  content?: string;
  since?: string;
  type?: string;
  stage?: string;
  resumeFrom?: string;
  // connect command flags
  url?: string;
  key?: string;
  target?: string;
  tool?: string;
  token?: string;
  write?: boolean;
  // audit-log flags
  user?: string;
}

export function parseCliArgs(args: string[]): CliArgs {
  const result: CliArgs = { command: args[0] ?? "" };
  let i = 1;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--project":
        result.project = args[++i];
        break;
      case "--category":
        result.category = args[++i];
        break;
      case "--agent":
        result.agent = args[++i];
        break;
      case "--query":
        result.query = args[++i];
        break;
      case "--limit":
        result.limit = parseInt(args[++i], 10);
        break;
      case "--output":
        result.output = args[++i];
        break;
      case "--json":
        result.json = true;
        break;
      case "--since":
        result.since = args[++i];
        break;
      case "--type":
        result.type = args[++i];
        break;
      case "--stage":
        result.stage = args[++i];
        break;
      case "--resume-from":
        result.resumeFrom = args[++i];
        break;
      case "--no-embed":
        // Legacy flag — ignored (embeddings removed)
        break;
      case "--url":
        result.url = args[++i];
        break;
      case "--key":
        result.key = args[++i];
        break;
      case "--target":
        result.target = args[++i];
        break;
      case "--tool":
        result.tool = args[++i];
        break;
      case "--token":
        result.token = args[++i];
        break;
      case "--write":
        result.write = true;
        break;
      case "--user":
        result.user = args[++i];
        break;
      default:
        // Positional argument = content (for store command)
        if (!arg.startsWith("--")) {
          result.content = arg;
        }
        break;
    }
    i++;
  }

  return result;
}

export async function handleCli(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: string[],
): Promise<void> {
  const parsed = parseCliArgs(args);

  switch (parsed.command) {
    case "store":
      await handleStore(store, initStore, parsed);
      break;
    case "recall":
      await handleRecall(store, initStore, parsed);
      break;
    case "status":
      await handleStatus(store, initStore, parsed);
      break;
    case "inject":
      await handleInject(store, initStore, parsed);
      break;
    case "sync":
      await handleSync(store, initStore, parsed);
      break;
    case "cleanup":
      await handleCleanup(store, initStore, parsed);
      break;
    case "enrich":
      await handleEnrich(store, initStore, parsed);
      break;
    case "meeting":
      await handleMeeting(store, initStore, parsed);
      break;
    case "transcribe":
      await handleTranscribe(store, initStore, parsed);
      break;
    case "audit":
      await handleAudit(store, initStore);
      break;
    case "audit-log":
      await handleAuditLog(store, initStore, parsed);
      break;
    case "briefing":
      await handleBriefing(store, initStore, parsed);
      break;
    case "analyze":
      await handleAnalyze(store, initStore);
      break;
    case "communities":
      await handleCommunities(store, initStore);
      break;
    case "patterns":
      await handlePatterns(store, initStore, parsed);
      break;
    case "import-slack":
      await handleImportSlack(store, initStore, parsed);
      break;
    case "lifecycle":
      await handleLifecycle(store, initStore, parsed);
      break;
    case "connect":
      await handleConnect(parsed);
      break;
    case "backup":
      await handleBackup(store, initStore, parsed);
      break;
    case "supersede":
      await handleSupersede(store, initStore, args.slice(1));
      break;
    case "org":
      await handleOrg(store, initStore, args.slice(1));
      break;
    case "connectors":
      handleConnectorsMarketplace();
      break;
    default:
      printUsage();
      process.exit(1);
  }
}

async function handleStore(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.project || !args.category || !args.content) {
    console.error("Usage: hive-memory store --project <id> --category <cat> [--agent <id>] \"content\"");
    process.exit(1);
  }

  validateId(args.project);
  const validCategories: MemoryCategory[] = ["decision", "learning", "status", "note"];
  if (!validCategories.includes(args.category as MemoryCategory)) {
    console.error(`Invalid category: ${args.category}. Must be one of: ${validCategories.join(", ")}`);
    process.exit(1);
  }

  await initStore();
  const entry = await store.storeMemory(
    args.project,
    args.category as MemoryCategory,
    args.content,
    [],
    args.agent,
  );
  console.log(`Stored ${args.category} for ${args.project} (id: ${entry.id})`);
}

async function handleRecall(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.query) {
    console.error("Usage: hive-memory recall --query <text> [--project <id>] [--agent <id>] [--limit N] [--json]");
    process.exit(1);
  }

  await initStore();
  const results = await store.recallMemories(args.query, args.project, args.limit ?? 5, args.agent);

  if (results.length === 0) {
    console.log("No matching memories found.");
    return;
  }

  if (args.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const r of results) {
    const label = r.source
      ? `[${r.project}/${r.source}] (reference)`
      : `[${r.project}/${r.category ?? "unknown"}]`;
    const agentStr = r.agent ? ` (agent: ${r.agent})` : "";
    console.log(`${label}${agentStr}`);
    console.log(`  ${r.snippet}`);
    if (r.path) console.log(`  Path: ${r.path}`);
    console.log("---");
  }
}

async function handleStatus(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.project) {
    console.error("Usage: hive-memory status --project <id>");
    process.exit(1);
  }

  validateId(args.project);
  await initStore();
  const summary = await store.getProjectSummary(args.project);

  if (!summary) {
    console.error(`Project "${args.project}" not found.`);
    process.exit(1);
  }

  console.log(`# ${summary.id}\n`);
  console.log(summary.oneLiner);
  console.log(`Tech: ${summary.techStack.join(", ")}`);
  console.log(`Modules: ${summary.modules.join(", ")}`);
  console.log(`Focus: ${summary.currentFocus}`);

  if (summary.lastSession) {
    console.log(`\n## Last Session (${summary.lastSession.date})\n`);
    console.log(summary.lastSession.summary);
    if (summary.lastSession.nextTasks.length > 0) {
      console.log("\nNext tasks:");
      for (const t of summary.lastSession.nextTasks) {
        console.log(`  - ${t}`);
      }
    }
  }
}

async function handleInject(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.project || !args.query || !args.output) {
    console.error("Usage: hive-memory inject --project <id> --query <text> --output <file> [--limit N]");
    process.exit(1);
  }

  validateId(args.project);
  await initStore();

  const results = await store.recallMemories(args.query, args.project, args.limit ?? 3);

  let content = "\n# Hive Memory Context\n\n";
  if (results.length === 0) {
    content += "<!-- No prior context found for this task -->\n";
  } else {
    for (const r of results) {
      const label = r.source
        ? `[${r.project}/${r.source}]`
        : `[${r.project}/${r.category ?? "unknown"}]`;
      content += `## ${label}\n${r.snippet}\n\n`;
    }
  }

  await appendFile(args.output, content, "utf-8");
  console.log(`Injected ${results.length} memories into ${args.output}`);
}

async function handleSync(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();

  if (args.project) {
    validateId(args.project);
    const syncCount = await store.syncReferences(args.project);
    const index = await store.getIndex();
    const proj = index.projects.find(p => p.id === args.project);
    let scanCount = 0;
    if (proj) {
      scanCount = await store.scanProjectReferences(args.project, proj.path);
    }
    console.log(`Synced ${args.project}: ${syncCount} updated, ${scanCount} scanned.`);
  } else {
    const index = await store.getIndex();
    let totalSync = 0;
    let totalScan = 0;
    for (const proj of index.projects) {
      const syncCount = await store.syncReferences(proj.id);
      const scanCount = await store.scanProjectReferences(proj.id, proj.path);
      if (syncCount > 0 || scanCount > 0) {
        console.log(`  ${proj.id}: ${syncCount} updated, ${scanCount} scanned`);
        totalSync += syncCount;
        totalScan += scanCount;
      }
    }
    console.log(`Synced all projects: ${totalSync} updated, ${totalScan} scanned.`);
  }
}

async function handleCleanup(
  store: CortexStore,
  initStore: () => Promise<void>,
  _args: CliArgs,
): Promise<void> {
  await initStore();
  const removed = await store.cleanupExpiredEntries();
  console.log(`Removed ${removed} expired status entries.`);
}

async function handleEnrich(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();
  const stage = args.stage as import("./enrichment/types.js").EnrichmentStage | undefined;
  const resumeFrom = args.resumeFrom as import("./enrichment/types.js").EnrichmentStage | undefined;
  const result = await store.enrichBatch({
    since: args.since,
    entityType: args.type
      ? (args.type.split(",") as import("./types.js").EntityType[])
      : undefined,
    limit: args.limit ?? 100,
    unenrichedOnly: !stage,
    stage,
    resumeFrom,
  });
  const stageSuffix = stage ? ` (stage: ${stage})` : "";
  console.log(
    `Enriched ${result.enriched}/${result.processed} entities${stageSuffix} (batchId: ${result.batchId})`,
  );
  if (result.errors > 0) {
    console.log(`Errors: ${result.errors}`);
  }
}

async function handleMeeting(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.content) {
    console.error("Usage: hive-memory meeting <transcript-file> [--title <title>] [--output <file>]");
    process.exit(1);
  }

  await initStore();
  const agent = new MeetingAgent(store.database, store.enrichmentEngine);

  const result = await agent.process({
    transcriptPath: args.content,
    title: args.query, // --query doubles as --title for meeting
    date: args.since,
  });

  if (args.output) {
    await writeFile(args.output, result.markdownOutput, "utf-8");
    console.log(`Meeting notes written to ${args.output}`);
  } else {
    console.log(result.markdownOutput);
  }

  console.error(
    `Processed meeting: ${result.decisionsCreated} decisions, ${result.actionsCreated} actions`,
  );
}

async function handleAudit(
  store: CortexStore,
  initStore: () => Promise<void>,
): Promise<void> {
  await initStore();
  const steward = new MemorySteward(store.database);
  const report = steward.audit();
  console.log(report.markdownOutput);
}

async function handleBriefing(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();
  const steward = new MemorySteward(store.database);
  const period = (args.type === "weekly" ? "weekly" : "daily") as "daily" | "weekly";
  const report = steward.briefing(period);
  console.log(report.markdownOutput);
}

async function handleAnalyze(
  store: CortexStore,
  initStore: () => Promise<void>,
): Promise<void> {
  await initStore();
  const advisor = new WorkflowAdvisor(store.database);
  const report = advisor.analyze();
  console.log(report.markdownOutput);
}

async function handleCommunities(
  store: CortexStore,
  initStore: () => Promise<void>,
): Promise<void> {
  await initStore();
  const { buildGraphRAGSummaries } = await import("./search/graph-rag.js");
  const result = buildGraphRAGSummaries(store.database);

  console.log(`# Knowledge Graph Communities\n`);
  console.log(result.globalSummary);
  console.log();

  for (const community of result.communities) {
    console.log(`## ${community.label} (${community.size} entities)`);
    console.log(community.summary);
    if (community.topEntities.length > 0) {
      console.log(`Top entities:`);
      for (const e of community.topEntities) {
        console.log(`  - [${e.id}] ${e.title}`);
      }
    }
    console.log();
  }

  if (result.communities.length === 0) {
    console.log("No communities detected (need at least 3 connected entities).");
  }
}

async function handlePatterns(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();
  const analyzer = new PatternAnalyzer(store.database);
  const report = analyzer.analyze({
    since: args.since,
    project: args.project,
  });
  console.log(report.markdownOutput);
}

async function handleTranscribe(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  if (!args.content) {
    console.error("Usage: hive-memory transcribe <audio/video file> [--title <title>] [--output <file>]");
    console.error("\nSupported: mp4, mkv, webm, mov, mp3, wav, m4a, ogg, flac");
    console.error("\nFull pipeline: audio → Whisper STT → meeting notes → enrichment");
    process.exit(1);
  }

  // Step 1: STT
  console.error("[pipeline] Step 1/4: Transcribing audio...");
  const sttResult = await transcribeToVTT({
    inputPath: args.content,
    model: process.env.WHISPER_MODEL ?? "base",
    language: process.env.WHISPER_LANGUAGE,
  });
  console.error(`[pipeline] Transcript: ${sttResult.vttPath} (${sttResult.durationSeconds}s, ${sttResult.engine})`);

  // Step 2: Process with MeetingAgent
  console.error("[pipeline] Step 2/4: Processing meeting notes...");
  await initStore();
  const agent = new MeetingAgent(store.database, store.enrichmentEngine);
  const result = await agent.process({
    transcriptPath: sttResult.vttPath,
    title: args.query,
    date: args.since,
  });

  // Step 3: Share (if configured)
  console.error("[pipeline] Step 3/4: Sharing...");
  const slackWebhook = process.env.MEETING_SLACK_WEBHOOK;
  const notionParent = process.env.MEETING_NOTION_PARENT;
  if (slackWebhook) {
    try {
      const { postToSlack } = await import("./meeting/output.js");
      await postToSlack({ webhookUrl: slackWebhook, markdown: result.markdownOutput });
      console.error("[pipeline] Posted to Slack ✓");
    } catch (err) {
      console.error(`[pipeline] Slack post failed: ${err}`);
    }
  }
  if (notionParent && process.env.NOTION_TOKEN) {
    try {
      const { postToNotion } = await import("./meeting/output.js");
      const url = await postToNotion({
        token: process.env.NOTION_TOKEN,
        parentPageId: notionParent,
        title: args.query ?? "Meeting Notes",
        markdown: result.markdownOutput,
      });
      console.error(`[pipeline] Created Notion page: ${url}`);
    } catch (err) {
      console.error(`[pipeline] Notion post failed: ${err}`);
    }
  }

  // Step 4: Output
  console.error("[pipeline] Step 4/4: Done!");
  console.error(`  Decisions: ${result.decisionsCreated}`);
  console.error(`  Actions: ${result.actionsCreated}`);
  console.error(`  Speakers: ${result.speakers.join(", ")}`);

  if (args.output) {
    await writeFile(args.output, result.markdownOutput, "utf-8");
    console.log(`Meeting notes written to ${args.output}`);
  } else {
    console.log(result.markdownOutput);
  }
}

async function handleConnect(args: CliArgs): Promise<void> {
  const { detectTool, generateMcpConfig, getConfigPath } = await import("./gateway/config-templates.js");
  const { mergeConfig } = await import("./gateway/config-writer.js");
  const { verifyConnection } = await import("./gateway/connect.js");

  const serverUrl = args.url ?? "http://localhost:3179";
  const apiKey = args.key ?? args.token ?? process.env["CORTEX_AUTH_TOKEN"] ?? "";

  // Resolve tool
  const rawTool = args.tool ?? args.target;
  if (rawTool === "raw") {
    // Raw JSON output mode
    const config = generateMcpConfig(serverUrl, apiKey);
    console.log(JSON.stringify({ cortex: config }, null, 2));
    return;
  }

  let resolvedTool: "claude" | "cursor" | null;
  if (rawTool === "claude" || rawTool === "claude-code") {
    resolvedTool = "claude";
  } else if (rawTool === "cursor") {
    resolvedTool = "cursor";
  } else {
    resolvedTool = detectTool();
  }

  if (!resolvedTool) {
    console.error("Could not auto-detect AI tool. Use --tool claude|cursor to specify.");
    console.error("Install Claude Code or Cursor to use auto-detection.");
    process.exit(1);
  }

  if (!apiKey) {
    console.log(`Pass your API key with --key <key> (get one with: hive-memory user create <name>)`);
    // Still show what the config would look like
    const config = generateMcpConfig(serverUrl, "<your-api-key>");
    const configPath = getConfigPath(resolvedTool);
    console.log(`\nAdd this to your config (${configPath}):`);
    console.log(JSON.stringify({ mcpServers: { cortex: config } }, null, 2));
    return;
  }

  const serverConfig = generateMcpConfig(serverUrl, apiKey);
  const configPath = getConfigPath(resolvedTool);
  const toolLabel = resolvedTool === "claude" ? "Claude Code" : "Cursor";

  if (args.write) {
    // Check if cortex entry already exists
    let hadExisting = false;
    try {
      const { existsSync, readFileSync } = await import("node:fs");
      if (existsSync(configPath)) {
        const existing = JSON.parse(readFileSync(configPath, "utf-8"));
        hadExisting = Boolean(existing?.mcpServers?.cortex);
      }
    } catch {
      // ignore parse errors
    }

    await mergeConfig(configPath, serverConfig);

    console.log(`Hive Memory — MCP Gateway Setup\n`);
    console.log(`Tool:   ${toolLabel}`);
    console.log(`Server: ${serverUrl}\n`);
    console.log(hadExisting ? `Updated existing cortex config in: ${configPath}` : `Config written to: ${configPath}`);
    console.log(`\nWarning: Your API key is stored in plaintext.`);
    console.log(`         Make sure ${configPath} is not committed to git.`);
  } else {
    // Dry-run: print config
    const label = resolvedTool === "claude" ? `~/.claude/settings.json` : `~/.cursor/mcp.json`;
    console.log(`Add this to your ${toolLabel} config (${label}):\n`);
    console.log(JSON.stringify({ mcpServers: { cortex: serverConfig } }, null, 2));
  }

  // Connection verification (informational, never fails the command)
  const reachable = await verifyConnection(serverUrl, apiKey);
  if (reachable) {
    console.log(`\nConnection verified — cortex MCP server is reachable.`);
  } else {
    console.log(`\nWarning: Could not reach the server at ${serverUrl}. Make sure it's running with --http flag.`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Restart your AI tool to pick up the new MCP server config.`);
  console.log(`  2. Try: "project_status" to verify the connection.`);
  if (resolvedTool === "cursor") {
    console.log(`\nNote: .cursor/mcp.json may need to be in the project root for Cursor.`);
  }
}

async function handleImportSlack(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  // The export directory is passed as the positional content arg
  const exportDir = args.content;
  if (!exportDir) {
    console.error("Usage: hive-memory import-slack <export-dir>");
    process.exit(1);
  }

  await initStore();
  const { importSlackExport } = await import("./pipeline/slack-import.js");
  const result = await importSlackExport(store.database, { exportDir });

  console.log(`Slack import complete:`);
  console.log(`  Channels: ${result.channels}`);
  console.log(`  Messages: ${result.messages}`);
  console.log(`  Users:    ${result.users}`);
  console.log(`  Errors:   ${result.errors}`);
  console.log(`  Duration: ${result.durationMs}ms`);
}

async function handleLifecycle(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  const subcommand = args.content ?? "stats";

  await initStore();
  const { DataLifecycleManager } = await import("./pipeline/lifecycle.js");
  const manager = new DataLifecycleManager(store.database);

  if (subcommand === "run") {
    const result = manager.runLifecycle();
    console.log(`Lifecycle run complete:`);
    console.log(`  Archived: ${result.archived}`);
    console.log(`  Hot:      ${result.hotCount}`);
    console.log(`  Warm:     ${result.warmCount}`);
  } else {
    // Default: stats
    const stats = manager.getStats();
    console.log(`Lifecycle stats:`);
    console.log(`  Total active: ${stats.total}`);
    console.log(`  Hot (< 30d):  ${stats.hot}`);
    console.log(`  Warm:         ${stats.warm}`);
    console.log(`  Archived:     ${stats.archived}`);
  }
}

async function handleBackup(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();
  const outputPath = args.output ?? "cortex-backup.db";
  store.database.backup(outputPath);
  console.log(`Database backed up to: ${outputPath}`);
}

async function handleSupersede(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: string[],
): Promise<void> {
  // Usage: hive-memory supersede <old-id> <new-id>
  // args[0] = old-id, args[1] = new-id (caller passes args.slice(1))
  const oldId = args[0];
  const newId = args[1];

  if (!oldId || !newId) {
    console.error("Usage: hive-memory supersede <old-id> <new-id>");
    process.exit(1);
  }

  await initStore();
  const db = store.database;

  const oldEntity = db.getEntity(oldId);
  if (!oldEntity) {
    console.error(`Entity not found: ${oldId}`);
    process.exit(1);
  }

  const newEntity = db.getEntity(newId);
  if (!newEntity) {
    console.error(`Entity not found: ${newId}`);
    process.exit(1);
  }

  db.supersede(oldId, newId);
  console.log(`Superseded: ${oldId} → ${newId}`);
  console.log(`Old entity marked with valid_to and status=superseded.`);
  console.log(`Refinement synapse created: ${newId} → ${oldId}`);
}

async function handleOrg(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: string[],
): Promise<void> {
  // Usage: hive-memory org <subcommand> [args...]
  const subcommand = args[0];
  await initStore();
  const db = store.database;

  switch (subcommand) {
    case "create": {
      // hive-memory org create <name> <slug>
      const name = args[1];
      const slug = args[2];
      if (!name || !slug) {
        console.error("Usage: hive-memory org create <name> <slug>");
        process.exit(1);
      }
      const org = db.createOrganization(name, slug);
      const workspace = db.createWorkspace(org.id, "default", "default");
      console.log(`Organization created: ${org.name} [${org.slug}] (id: ${org.id})`);
      console.log(`Default workspace created: ${workspace.name} [${workspace.slug}] (id: ${workspace.id})`);
      break;
    }

    case "list": {
      const orgs = db.listOrganizations();
      if (orgs.length === 0) {
        console.log("No organizations found.");
        return;
      }
      for (const org of orgs) {
        const workspaces = db.listWorkspaces(org.id);
        console.log(`${org.id}  ${org.name}  [${org.slug}]  ${org.status}`);
        for (const ws of workspaces) {
          console.log(`  workspace: ${ws.slug} (${ws.id})`);
        }
      }
      break;
    }

    case "invite": {
      // hive-memory org invite <org-slug> <user-id>
      const orgSlug = args[1];
      const userId = args[2];
      if (!orgSlug || !userId) {
        console.error("Usage: hive-memory org invite <org-slug> <user-id>");
        process.exit(1);
      }
      const org = db.getOrganizationBySlug(orgSlug);
      if (!org) {
        console.error(`Organization not found: ${orgSlug}`);
        process.exit(1);
      }
      const workspaces = db.listWorkspaces(org.id);
      const defaultWorkspace = workspaces[0];
      db.assignUserToOrg(userId, org.id, defaultWorkspace?.id);
      const wsInfo = defaultWorkspace ? ` (workspace: ${defaultWorkspace.slug})` : "";
      console.log(`User ${userId} added to organization ${org.name} (${orgSlug})${wsInfo}.`);
      break;
    }

    default:
      console.error(`Unknown org subcommand: ${subcommand ?? "(none)"}`);
      console.error("Usage: hive-memory org <create|list|invite>");
      process.exit(1);
  }
}

async function handleAuditLog(
  store: CortexStore,
  initStore: () => Promise<void>,
  args: CliArgs,
): Promise<void> {
  await initStore();
  const entries = store.database.queryAuditLog({
    userId: args.user,
    since: args.since,
    limit: args.limit ?? 100,
  });

  if (entries.length === 0) {
    console.log("No audit log entries found.");
    return;
  }

  for (const e of entries) {
    const user = e.userId ?? "system";
    const tool = e.toolName ? ` [${e.toolName}]` : "";
    const query = e.query ? ` q="${e.query}"` : "";
    const count = e.resultCount !== undefined ? ` results=${e.resultCount}` : "";
    console.log(`${e.timestamp}  ${user}  ${e.action}${tool}${query}${count}`);
  }
}

function handleConnectorsMarketplace(): void {
  const marketplace = new ConnectorMarketplace();
  for (const manifest of BUILT_IN_CONNECTORS) {
    marketplace.register(manifest);
  }

  const all = marketplace.list();
  const configured = all.filter(c => c.configured);
  const unconfigured = all.filter(c => !c.configured);

  console.log(`Connector Marketplace (${all.length} available)\n`);

  if (configured.length > 0) {
    console.log(`Configured (${configured.length}):`);
    for (const c of configured) {
      console.log(`  [✓ configured] ${c.name} (${c.id})`);
      console.log(`    ${c.description}`);
    }
    console.log(``);
  }

  if (unconfigured.length > 0) {
    console.log(`Not configured (${unconfigured.length}):`);
    for (const c of unconfigured) {
      console.log(`  [✗ not configured] ${c.name} (${c.id})`);
      console.log(`    ${c.description}`);
      console.log(`    Required env: ${c.requiredEnvVars.join(", ")}`);
    }
  }
}

function printUsage(): void {
  console.log(`Usage: hive-memory <command> [options]

Commands:
  store     Store a memory entry
  recall    Search and recall memories (keyword + graph traversal)
  status    Show project status
  inject    Recall memories and append to file
  sync      Sync external agent memory files
  cleanup   Remove expired entries
  enrich    Run enrichment on entities (--since, --type, --limit)
  meeting   Process a meeting transcript (--title, --output)
  transcribe  Full pipeline: audio/video → STT → meeting notes (TLDV replacement)
  audit     Run memory data quality audit
  briefing  Generate daily/weekly briefing (--type daily|weekly)
  analyze   Analyze workflow patterns and generate insights
  patterns  Analyze aggregated working patterns (--since, --project)
  communities   Detect knowledge graph communities (GraphRAG-style summaries)
  connect   Generate MCP config for Claude Code or Cursor (--url, --key, --tool, --write)
  import-slack <dir>   Import Slack Enterprise Grid export
  lifecycle [run|stats]   Data lifecycle management (archive old entities)
  backup    Backup SQLite database (--output <path>, default: cortex-backup.db)
  supersede <old-id> <new-id>   Mark entity as superseded by newer entity
  connectors            List all available connectors with configuration status
  org create <name> <slug>      Create organization + default workspace
  org list                      List all organizations
  org invite <org-slug> <user-id>   Add user to organization

  hook session-end    Auto-save session (Claude Code hook)

Options:
  --project <id>      Project ID
  --category <cat>    Memory category (decision|learning|status|note)
  --agent <id>        Agent identifier
  --query <text>      Search query
  --limit <n>         Max results (default: 5)
  --output <file>     Output file path (for inject)
  --json              Output as JSON

Without a command, starts as MCP server (stdio transport).`);
}
