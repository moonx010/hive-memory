## ADDED Requirements

### Requirement: Agent identification on memory storage
The system SHALL accept an optional `agentId` string when storing a memory via `memory_store`. The agentId identifies which agent (e.g., `claude-main`, `codex-w1`, `cursor`) created the entry.

#### Scenario: Store memory with agentId
- **WHEN** an agent calls `memory_store` with `agentId: "codex-w1"`
- **THEN** the stored DirectEntry SHALL include `agentId: "codex-w1"`

#### Scenario: Store memory without agentId (backward compat)
- **WHEN** an agent calls `memory_store` without providing `agentId`
- **THEN** the stored DirectEntry SHALL have `agentId: undefined` and function identically to v2.0 behavior

### Requirement: Agent filter on memory recall
The system SHALL support filtering `memory_recall` results by `agentId`.

#### Scenario: Recall filtered by agent
- **WHEN** a user calls `memory_recall` with `agent: "codex-w1"`
- **THEN** only entries where `agentId === "codex-w1"` SHALL be returned

#### Scenario: Recall without agent filter
- **WHEN** a user calls `memory_recall` without the `agent` parameter
- **THEN** all matching entries SHALL be returned regardless of agentId

### Requirement: Agent identity in search results
The system SHALL include `agentId` in HiveSearchResult when the source entry has one.

#### Scenario: Search result includes agent info
- **WHEN** a memory_recall returns a DirectEntry that has `agentId: "claude-main"`
- **THEN** the result object SHALL include `agent: "claude-main"`
