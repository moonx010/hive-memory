import { appendFile, writeFile } from "node:fs/promises";
import type { CortexStore } from "./store.js";
import type { MemoryCategory } from "./types.js";
import { validateId } from "./store/io.js";
import { MeetingAgent } from "./meeting/agent.js";
import { MemorySteward } from "./steward/index.js";
import { WorkflowAdvisor } from "./advisor/index.js";
import { PatternAnalyzer } from "./advisor/patterns.js";

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
    case "audit":
      await handleAudit(store, initStore);
      break;
    case "briefing":
      await handleBriefing(store, initStore, parsed);
      break;
    case "analyze":
      await handleAnalyze(store, initStore);
      break;
    case "patterns":
      await handlePatterns(store, initStore, parsed);
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
  audit     Run memory data quality audit
  briefing  Generate daily/weekly briefing (--type daily|weekly)
  analyze   Analyze workflow patterns and generate insights
  patterns  Analyze aggregated working patterns (--since, --project)

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
