# Contributing to Hive Memory

Thanks for your interest in contributing! This guide will help you get set up.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/moonx010/hive-memory.git
cd hive-memory

# Install dependencies
npm install

# Build
npm run build

# Run in dev mode (auto-reload)
npm run dev
```

## Testing Locally with Claude Code

1. Build the project:

```bash
npm run build
```

2. Add to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "hive-memory": {
      "command": "node",
      "args": ["/absolute/path/to/hive-memory/dist/index.js"]
    }
  }
}
```

3. Restart Claude Code. The Hive Memory tools should now be available.

4. Test by asking Claude to run `project_list` or `project_onboard("~/your-workspace")`.

## Native Module (Optional)

Hive Memory includes an optional native module for semantic search using embeddings. This is **not required** for basic functionality.

```bash
# Build native module (requires Rust toolchain)
npm run build:native

# Or build everything
npm run build:all
```

If the native module is not available, Hive Memory falls back to keyword-based search.

## Project Structure

```
src/
  index.ts    — Entry point, MCP server setup
  tools.ts    — Tool definitions and handlers
  store.ts    — Data persistence layer
  types.ts    — TypeScript type definitions
native/       — Optional Rust native module for embeddings
```

## Pull Request Guidelines

1. **Keep PRs focused** — one feature or fix per PR.
2. **Run the build** before submitting: `npm run build`
3. **Run type checking**: `npm run typecheck`
4. **Write clear commit messages** describing the "why", not just the "what".
5. **Test with Claude Code** to verify MCP tools work correctly.

## Reporting Issues

Please open an issue on [GitHub](https://github.com/moonx010/hive-memory/issues) with:

- What you expected to happen
- What actually happened
- Your Node.js version (`node --version`)
- Your MCP client (Claude Code, Claude Desktop, Cursor, etc.)
