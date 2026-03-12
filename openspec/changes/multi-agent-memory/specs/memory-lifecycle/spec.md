## ADDED Requirements

### Requirement: TTL for status memories
The system SHALL support automatic expiration of `status` category memories after a configurable TTL (default: 30 days).

#### Scenario: Expired status memory excluded from recall
- **WHEN** a `status` memory was created more than 30 days ago
- **THEN** `memory_recall` SHALL exclude it from results

#### Scenario: Decision memories never expire
- **WHEN** a `decision` memory was created 1 year ago
- **THEN** `memory_recall` SHALL still include it if it matches the query

### Requirement: Conflict detection for same-topic memories
The system SHALL detect when multiple agents store conflicting decisions about the same topic and flag them.

#### Scenario: Conflicting decisions detected
- **WHEN** agent A stores "Use PostgreSQL for persistence" and agent B stores "Use SQLite for persistence" within the same project
- **THEN** `memory_recall` for "persistence" SHALL return both entries with a `conflict: true` flag

#### Scenario: Non-conflicting decisions
- **WHEN** agent A stores "Use PostgreSQL" and agent B stores "Add connection pooling" for the same project
- **THEN** `memory_recall` SHALL return both entries without conflict flags

### Requirement: CLI cleanup command
The system SHALL provide a `hive-memory cleanup` CLI subcommand that removes expired entries and reports statistics.

#### Scenario: Cleanup expired entries
- **WHEN** a user runs `hive-memory cleanup`
- **THEN** the system SHALL remove all expired `status` entries and report how many were removed
