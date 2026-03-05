#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { CortexStore } from "./store.js";
import { registerTools } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

const DATA_DIR =
  process.env["CORTEX_DATA_DIR"] ?? join(homedir(), ".cortex");
const SYNC_LOCAL = process.env["CORTEX_LOCAL_SYNC"] !== "false";

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

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  // CLI mode: hive-memory hook <subcommand> [args...]
  if (args[0] === "hook") {
    await handleHook(args.slice(1));
    return;
  }

  // Default: MCP server mode
  const store = createStore();
  await store.init();

  const server = new McpServer({
    name: "cortex",
    version: pkg.version as string,
  });

  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Cortex failed to start:", err);
  process.exit(1);
});
