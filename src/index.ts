#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { CortexStore } from "./store.js";
import { registerTools } from "./tools.js";

const DATA_DIR =
  process.env["CORTEX_DATA_DIR"] ?? join(homedir(), ".cortex");
const SYNC_LOCAL = process.env["CORTEX_LOCAL_SYNC"] !== "false";

async function main() {
  const store = new CortexStore({
    dataDir: DATA_DIR,
    localContext: {
      filename: process.env["CORTEX_LOCAL_FILENAME"] ?? ".cortex.md",
      enabled: SYNC_LOCAL,
    },
  });
  await store.init();

  const server = new McpServer({
    name: "cortex",
    version: "1.0.0", // Keep in sync with package.json
  });

  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Cortex failed to start:", err);
  process.exit(1);
});
