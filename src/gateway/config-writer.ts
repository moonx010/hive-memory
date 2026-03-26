import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { McpServerConfig, McpConfigFile } from "./config-templates.js";

export async function mergeConfig(
  configPath: string,
  serverConfig: McpServerConfig,
): Promise<void> {
  let existing: McpConfigFile = { mcpServers: {} };

  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf-8");
    existing = JSON.parse(content) as McpConfigFile;
    if (!existing.mcpServers) existing.mcpServers = {};
  }

  // Merge — only touches the "cortex" key
  existing.mcpServers.cortex = serverConfig;

  // Write with 2-space indent for readability
  const dir = dirname(configPath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}
