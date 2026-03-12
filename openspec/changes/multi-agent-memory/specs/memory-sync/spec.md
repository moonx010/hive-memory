## ADDED Requirements

### Requirement: CLI sync command for external agent memory
The system SHALL provide a `hive-memory sync` CLI subcommand that scans registered projects for external agent memory files and updates ReferenceEntries in the hive.

#### Scenario: Sync detects new MEMORY.md
- **WHEN** a user runs `hive-memory sync --project myapp` and `myapp` has a new `MEMORY.md` file not yet indexed
- **THEN** the system SHALL create a ReferenceEntry pointing to the MEMORY.md file

#### Scenario: Sync updates changed file
- **WHEN** a user runs `hive-memory sync --project myapp` and the existing MEMORY.md has been modified since lastSynced
- **THEN** the system SHALL update the ReferenceEntry's description and lastSynced timestamp

#### Scenario: Sync all projects
- **WHEN** a user runs `hive-memory sync` without --project
- **THEN** the system SHALL scan all registered projects for external memory files

### Requirement: Onboard auto-sync
The system SHALL automatically run reference scanning during `project_onboard` (existing behavior preserved).

#### Scenario: Onboard triggers reference scan
- **WHEN** `project_onboard` registers a new project
- **THEN** the system SHALL scan for MEMORY.md, CLAUDE.md, AGENTS.md, and .cursor/rules files and create ReferenceEntries
