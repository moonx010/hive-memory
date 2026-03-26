# Design: mcp-gateway

## Overview

A CLI command `hive-memory connect` that generates MCP config for Claude Code and Cursor, enabling one-command connection to a shared hive-memory HTTP server. Purely client-side — no new server endpoints.

## Directory / File Layout

```
src/
  cli.ts                 ← add "connect" command handler
  index.ts               ← add "connect" to CLI_COMMANDS set
  gateway/
    config-templates.ts  ← NEW: MCP config templates for Claude Code, Cursor
    config-writer.ts     ← NEW: read/merge/write config files safely
```

## CLI Interface

```bash
# Auto-detect tool, prompt for token
hive-memory connect

# Explicit tool + token
hive-memory connect --tool claude --url http://myserver:3179 --token hm_a1b2c3...

# Write directly to config file (merge, don't overwrite)
hive-memory connect --tool cursor --write

# Show config for a custom agent (just the JSON)
hive-memory connect --tool raw
```

## Config Templates

```typescript
// src/gateway/config-templates.ts

interface McpServerConfig {
  url: string;
  headers: Record<string, string>;
}

interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

export function generateConfig(serverUrl: string, apiKey: string): McpServerConfig {
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
```

## Config Merge Strategy

The `--write` flag reads the existing config file, merges the `cortex` entry, and writes back. Never overwrites other entries.

```typescript
// src/gateway/config-writer.ts

export async function mergeConfig(
  configPath: string,
  serverConfig: McpServerConfig,
): Promise<void> {
  let existing: McpConfigFile = { mcpServers: {} };

  if (existsSync(configPath)) {
    const content = readFileSync(configPath, "utf-8");
    existing = JSON.parse(content);
    if (!existing.mcpServers) existing.mcpServers = {};
  }

  // Merge — only touches the "cortex" key
  existing.mcpServers.cortex = serverConfig;

  // Write with 2-space indent for readability
  const dir = dirname(configPath);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(existing, null, 2) + "\n");
}
```

## Tool Auto-Detection

```typescript
function detectTool(): "claude" | "cursor" | null {
  const home = homedir();
  if (existsSync(join(home, ".claude"))) return "claude";
  if (existsSync(join(home, ".cursor"))) return "cursor";
  return null;
}
```

## Connection Verification

After generating config, attempt a health check:

```typescript
async function verifyConnection(serverUrl: string, apiKey: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "initialize", id: 1, params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "hive-memory-connect", version: "1.0.0" },
      }}),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

## CLI Output

### Success (stdout)

```
Hive Memory — MCP Gateway Setup

Tool:   Claude Code
Server: http://myserver:3179
User:   alice

Config written to: /Users/alice/.claude/settings.json

Connection verified — cortex MCP server is reachable.

Next steps:
  1. Restart Claude Code to pick up the new MCP server.
  2. Try: "project_status" to verify the connection.

Warning: Your API key is stored in plaintext in the config file.
         Make sure /Users/alice/.claude/settings.json is not committed to git.
```

### Dry run (no --write)

```
Add this to your Claude Code config (~/.claude/settings.json):

{
  "mcpServers": {
    "cortex": {
      "url": "http://myserver:3179/mcp",
      "headers": {
        "Authorization": "Bearer hm_a1b2c3..."
      }
    }
  }
}
```

## Key Design Decisions

1. **Merge, not overwrite** — existing MCP servers in the config file are preserved. Only the `cortex` key is touched.
2. **Auto-detection with override** — detect Claude/Cursor from filesystem, but allow `--tool` flag to override.
3. **Connection verification** — attempt a real MCP `initialize` call to confirm the server is reachable and the token is valid.
4. **No interactive prompts in v1** — all input via flags. If `--token` is omitted and no default is available, print instructions rather than blocking.
5. **Platform-aware paths** — use `os.homedir()` for all config path resolution.
