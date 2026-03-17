# Cortex Research Notes

## Existing Solutions Survey (2026-02)

### General-Purpose Agent Memory Systems

| Tool | Stars | Key Features | Limitations |
|------|-------|-------------|-------------|
| [Mem0](https://github.com/mem0ai/mem0) | 41k+ | 90% token reduction, episodic/semantic/procedural memory | Built for general frameworks, not Claude Code specific |
| [Letta/MemGPT](https://github.com/letta-ai/letta) | - | OS virtual memory pattern, Context Repositories (Git-based) | Locked to its own agent platform |
| [Zep/Graphiti](https://github.com/getzep/graphiti) | 20k+ | Time-aware knowledge graph, #1 on DMR benchmark | Neo4j dependency |
| [OpenMemory](https://github.com/CaviraOSS/OpenMemory) | - | Local-first, MCP native, 5 memory sectors | New project |
| [MemOS](https://github.com/MemTensor/MemOS) | - | "Memory OS", explicitly designed for cross-project sharing | New (2025.05) |

### Claude Code Memory Extension Plugins

| Tool | Features |
|------|----------|
| [Claude-Mem](https://github.com/thedotmack/claude-mem) | Auto-capture session activity, AI compression |
| [Memsearch](https://github.com/zilliztech/memsearch) | Markdown-based, vector index, Zilliz/Milvus |
| [Claude-Supermemory](https://github.com/supermemoryai/claude-supermemory) | Cross-project profiles (paid) |

### MCP Memory Servers

| Server | Features |
|--------|----------|
| [Official Knowledge Graph Memory](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) | Entity-relation-observation model, basic |
| [xgmem](https://github.com/meetdhanani17/xgmem) | Per-project + cross-project knowledge graph |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 5ms search, multi-agent support |

### Differentiators

Most existing tools are:
- Built for general agent frameworks (LangChain, CrewAI, etc.)
- Simple CRUD knowledge graphs
- Single-project scoped

**Cortex's edge**: A dedicated tool for Claude Code users working across multiple projects in parallel — restore context with a single query like "how's that auth refactor going?"

## Key Design Insights

### Token Efficiency
- Mem0: 1.8K tokens per conversation (90% reduction vs full 26K context)
- Core pattern: Extraction → Update → Retrieval pipeline
- Progressive Disclosure: always load summaries, load details only on demand

### Architecture Patterns
- Hub-and-Spoke: central summary + per-project details
- Letta Context Repositories: Git-based memory versioning, file tree = navigation index
- Sync: auto-push summary on session end, pull relevant updates on session start

### Storage Evolution Path
1. Markdown/JSON (0-5 projects) → instant start
2. SQLite + FTS5 (5-20 projects) → full-text search
3. SQLite + sqlite-vec (20+ projects) → semantic search

### Conflict Resolution
- Append-only + periodic LLM defragmentation is the most practical approach
