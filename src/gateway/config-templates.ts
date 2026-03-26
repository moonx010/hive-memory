import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

export interface McpServerConfig {
  url: string;
  headers: Record<string, string>;
}

export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export function generateMcpConfig(serverUrl: string, apiKey: string): McpServerConfig {
  return {
    url: `${serverUrl}/mcp`,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

export function getConfigPath(tool: "claude" | "cursor"): string {
  const home = homedir();
  switch (tool) {
    case "claude": return join(home, ".claude", "settings.json");
    case "cursor": return join(home, ".cursor", "mcp.json");
  }
}

export function detectTool(): "claude" | "cursor" | null {
  const home = homedir();
  if (existsSync(join(home, ".claude"))) return "claude";
  if (existsSync(join(home, ".cursor"))) return "cursor";
  return null;
}
