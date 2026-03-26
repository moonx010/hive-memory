# Change: mcp-gateway

**Layer:** 1 (Hive-Memory)
**One-liner:** CLI command that generates MCP config for Claude Code and Cursor, enabling one-command connection to a shared hive-memory server.
**Estimated effort:** 2-3 days
**Dependencies:** multi-user-access (for per-user API keys)

## Why

Connecting a personal AI agent to a shared hive-memory instance currently requires:
1. Knowing the server URL and port.
2. Getting an API key from whoever deployed the server.
3. Manually editing `~/.claude/settings.json` or `.cursor/mcp.json`.
4. Getting the JSON format exactly right.

This friction kills adoption. A single `hive-memory connect` command should handle all of it.

## What Changes

### In Scope

1. **New CLI command: `hive-memory connect`**
   - Flags: `--tool claude|cursor` (auto-detected from environment if omitted), `--url <server-url>` (default: `http://localhost:3179`), `--token <api-key>` (prompts if omitted), `--write` (write directly to config file instead of stdout).
   - Auto-detection: checks for `~/.claude` directory (Claude Code) or `.cursor` directory (Cursor).
   - Generates the MCP server config JSON with the correct URL and auth header.
   - With `--write`: reads existing config file, merges the `cortex` server entry into `mcpServers`, writes back. Never overwrites other MCP servers.

2. **Config templates:**

   Claude Code (`~/.claude/settings.json`):
   ```json
   {
     "mcpServers": {
       "cortex": {
         "url": "http://<host>:3179/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

   Cursor (`.cursor/mcp.json`):
   ```json
   {
     "mcpServers": {
       "cortex": {
         "url": "http://<host>:3179/mcp",
         "headers": { "Authorization": "Bearer <token>" }
       }
     }
   }
   ```

3. **Connection verification:** after config generation, attempt a health check to the server URL. Print success/failure status.

4. **Implementation in `src/cli.ts`** — add `connect` to `CLI_COMMANDS` in `src/index.ts` and implement the handler in `src/cli.ts`.

### Out of Scope

- VS Code / Continue / Roo / other tool configs (add later as needed)
- Auto-discovery of running hive-memory servers on the network
- TUI wizard / interactive setup
- Config file migration on server URL change

## How to Verify

1. `hive-memory connect --tool claude --url http://myserver:3179 --token abc123` prints valid JSON config.
2. `hive-memory connect --write` merges into existing `~/.claude/settings.json` without destroying other entries.
3. `hive-memory connect` with no flags auto-detects Claude Code and prompts for token.
4. After running `connect --write`, Claude Code can successfully use cortex MCP tools.
5. Invalid URL or token shows a clear error message.

## Risks

| Risk | Mitigation |
|------|------------|
| Config file format changes in Claude Code / Cursor | Version-pin known formats; test against current versions |
| Writing to existing config corrupts other MCP servers | Read → parse → merge → write (never overwrite entire file) |
| Different config paths on Linux / macOS / Windows | Use `os.homedir()` + platform-specific paths |
| User commits API key to git | Print warning about adding config to `.gitignore` |
