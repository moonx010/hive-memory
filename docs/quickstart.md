# Quickstart — Hive Memory

## Install (2 min)

```bash
npm install hive-memory
# or clone + npm install + npm run build
```

## Start MCP Server (1 min)

```bash
CORTEX_HTTP=true node dist/index.js
# Listens on port 3179
```

## Connect Claude Code (1 min)

```bash
hive-memory connect --url http://localhost:3179 --tool claude-code --write
```

## First Sync (3 min)

```bash
export SLACK_TOKEN=xoxb-...
export SLACK_CHANNELS=C0...
hive-memory sync slack
```

## Search

```bash
hive-memory recall --query "architecture decision"
```

## Enrich

```bash
CORTEX_ENRICHMENT=rule hive-memory enrich --limit 100
```

## What's next

- Add more connectors (GitHub, Notion, Calendar)
- Enable ACL: `CORTEX_ACL=on`
- Enable hybrid search: `CORTEX_EMBEDDING_PROVIDER=local`
- Manage users: `hive-memory user create <name>`
- Run the data quality audit: `hive-memory audit`
- Set up team sync: `hive-memory team init <path>`
