## ADDED Requirements

### Requirement: Worker context injection script
The system SHALL provide a `scripts/worker-inject.sh` script that recalls relevant memories for a task and writes them to a file for worker consumption.

#### Scenario: Inject context before worker starts
- **WHEN** the orchestrator runs `worker-inject.sh <project> "<task description>" <output-file>`
- **THEN** the script SHALL call `hive-memory recall` with the task description, append results to the output file, and include recent project decisions

#### Scenario: Inject with no matching memories
- **WHEN** the script runs but no relevant memories exist
- **THEN** the output file SHALL contain only a header comment indicating no prior context was found

### Requirement: Worker result capture script
The system SHALL provide a `scripts/worker-capture.sh` script that stores a worker's output as a memory entry after task completion.

#### Scenario: Capture worker result
- **WHEN** the orchestrator runs `worker-capture.sh <project> <worker-id> <task-id>`
- **THEN** the script SHALL extract the latest commit message, store it as a `learning` memory with `agentId: "codex-w<worker-id>"`, and tag it with the task-id

#### Scenario: Capture when worker made no commits
- **WHEN** the script runs but the worker branch has no new commits
- **THEN** the script SHALL store a `note` memory indicating the task produced no changes

### Requirement: Integration with codex-parallel.sh
The worker scripts SHALL be compatible with the existing `codex-parallel.sh` orchestration flow.

#### Scenario: End-to-end multi-agent flow
- **WHEN** `codex-parallel.sh` runs with 3 workers
- **THEN** each worker SHALL have context injected before start and results captured after completion, with all memories tagged by worker ID
