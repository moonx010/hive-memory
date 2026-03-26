import { generateMcpConfig, getConfigPath } from "./config-templates.js";
import { mergeConfig } from "./config-writer.js";

export interface ConnectOptions {
  serverUrl: string;
  apiKey: string;
  target: "claude-code" | "cursor";
}

export interface ConnectResult {
  configPath: string;
  serverName: string;
  written: boolean;
}

/** Generate and write MCP config for the specified target. */
export async function connectAgent(opts: ConnectOptions): Promise<ConnectResult> {
  const tool = opts.target === "claude-code" ? "claude" : "cursor";
  const configPath = getConfigPath(tool);
  const serverConfig = generateMcpConfig(opts.serverUrl, opts.apiKey);

  await mergeConfig(configPath, serverConfig);

  return {
    configPath,
    serverName: "cortex",
    written: true,
  };
}

/** Verify connection to MCP server by sending initialize. */
export async function verifyConnection(serverUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "initialize",
        id: 1,
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "hive-memory-connect", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
