## ADDED Requirements

### Requirement: CLI store command
The system SHALL provide a `hive-memory store` CLI subcommand that stores a memory entry without requiring MCP.

#### Scenario: Store via CLI
- **WHEN** a process runs `hive-memory store --project myapp --category decision --agent codex-w1 "Use zod for validation"`
- **THEN** the system SHALL create a DirectEntry with project=myapp, category=decision, agentId=codex-w1, content="Use zod for validation"

#### Scenario: Store via CLI without agent
- **WHEN** a process runs `hive-memory store --project myapp --category learning "SQLite WAL is faster"`
- **THEN** the system SHALL create a DirectEntry with agentId=undefined

### Requirement: CLI recall command
The system SHALL provide a `hive-memory recall` CLI subcommand that performs semantic search and outputs results to stdout.

#### Scenario: Recall via CLI
- **WHEN** a process runs `hive-memory recall --project myapp --query "validation approach" --limit 3`
- **THEN** the system SHALL output up to 3 matching results in human-readable format to stdout

#### Scenario: Recall with JSON output
- **WHEN** a process runs `hive-memory recall --project myapp --query "auth" --json`
- **THEN** the system SHALL output results as a JSON array to stdout

### Requirement: CLI status command
The system SHALL provide a `hive-memory status` CLI subcommand that shows project context.

#### Scenario: Status via CLI
- **WHEN** a process runs `hive-memory status --project myapp`
- **THEN** the system SHALL output project summary, last session, and current focus to stdout

### Requirement: CLI inject command
The system SHALL provide a `hive-memory inject` CLI subcommand that recalls memories and appends them to a file.

#### Scenario: Inject context to file
- **WHEN** a process runs `hive-memory inject --project myapp --query "auth patterns" --output PROMPT.md`
- **THEN** the system SHALL recall relevant memories and append them to PROMPT.md in a readable format

### Requirement: CLI no-embed mode
The system SHALL support a `--no-embed` flag on all CLI commands that skips embedding initialization for faster execution.

#### Scenario: Fast CLI without embedding
- **WHEN** a process runs `hive-memory store --no-embed --project myapp --category note "quick note"`
- **THEN** the system SHALL store the entry using keyword indexing only, without loading the embedding model
