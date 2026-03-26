# Tasks: mcp-gateway

**Phase:** C (after multi-user-access)
**Estimated effort:** 2-3 days
**Dependencies:** multi-user-access (for per-user API keys)

## Day 1: Config Templates + CLI Skeleton

- [ ] **TASK-GW-01**: Create `src/gateway/config-templates.ts`
  - Export `generateMcpConfig(serverUrl, apiKey): McpServerConfig`
    - Returns `{ url: "${serverUrl}/mcp", headers: { Authorization: "Bearer ${apiKey}" } }`
  - Export `getConfigPath(tool: "claude" | "cursor"): string`
    - Claude Code: `join(homedir(), ".claude", "settings.json")`
    - Cursor: `join(homedir(), ".cursor", "mcp.json")`
  - Export `detectTool(): "claude" | "cursor" | null`
    - Check `existsSync(join(homedir(), ".claude"))` → "claude"
    - Check `existsSync(join(homedir(), ".cursor"))` → "cursor"
    - Neither → null
  - Test: generateMcpConfig returns correct JSON structure; detectTool returns correct value based on filesystem

- [ ] **TASK-GW-02**: Create `src/gateway/config-writer.ts`
  - Export `mergeConfig(configPath, serverConfig): Promise<void>`
    - Read existing file if it exists (handle missing file gracefully)
    - Parse as JSON, ensure `mcpServers` key exists
    - Set `mcpServers.cortex = serverConfig` (only touches the `cortex` key)
    - Write back with `JSON.stringify(data, null, 2) + "\n"`
    - Create parent directory if it doesn't exist (`mkdir -p`)
  - Test: merge into empty file → correct structure; merge into existing file with other MCP servers → cortex added, others preserved

- [ ] **TASK-GW-03**: Add `connect` command to CLI
  - Add `"connect"` to `CLI_COMMANDS` set in `src/index.ts` (line 98)
  - Parse flags: `--tool claude|cursor|raw`, `--url <url>` (default: `http://localhost:3179`), `--token <key>`, `--write`
  - Implement in `src/cli.ts` `handleCli` function (follow existing command pattern)
  - If `--tool` not provided: auto-detect via `detectTool()`; if null, error with instructions
  - If `--token` not provided: print message "Pass your API key with --token <key> (get one with: hive-memory user create <name>)"

## Day 2: Config Writing + Connection Verification

- [ ] **TASK-GW-04**: Implement `--write` mode
  - Call `mergeConfig(configPath, serverConfig)`
  - Print success message: "Config written to: {path}"
  - Print warning: "Your API key is stored in plaintext. Make sure this file is not committed to git."
  - If config file already has a `cortex` entry: print "Updated existing cortex config" (not "Added")

- [ ] **TASK-GW-05**: Implement connection verification
  - After config generation (both stdout and --write modes), attempt health check
  - POST to `{serverUrl}/mcp` with MCP `initialize` JSON-RPC request
  - Timeout: 5 seconds
  - Success: print "Connection verified — cortex MCP server is reachable."
  - Failure: print "Warning: Could not reach the server at {url}. Make sure it's running with --http flag."
  - Never fail the command on connection check failure — it's informational

- [ ] **TASK-GW-06**: Implement `--tool raw` mode
  - Output only the JSON config object (no surrounding text), for piping to other tools
  - Format: `{ "cortex": { "url": "...", "headers": { ... } } }`

## Day 3: Testing + Docs

- [ ] **TASK-GW-07**: Write tests
  - Create `tests/gateway.test.ts`
  - Test config generation: correct URL, correct auth header format
  - Test config merge: preserves existing MCP servers, updates cortex entry
  - Test auto-detection: mock filesystem for Claude/Cursor detection
  - Test raw output: valid JSON, parseable

- [ ] **TASK-GW-08**: Update `deploy/.env.example`
  - Add section documenting `hive-memory connect` usage
  - Note that `--url` defaults to `http://localhost:3179`
  - Note that `hive-memory user create` is prerequisite for `--token`

- [ ] **TASK-GW-09**: Print next-steps guide
  - After config output, print:
    ```
    Next steps:
      1. Restart your AI tool to pick up the new MCP server config.
      2. Try: "project_status" to verify the connection.
    ```
  - For Cursor: note that `.cursor/mcp.json` may need to be in the project root
