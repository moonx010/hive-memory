## ADDED Requirements

### Requirement: Atomic nursery flush with file lock
The system SHALL acquire an exclusive file lock before flushing the nursery buffer to hive cells, preventing concurrent flush corruption.

#### Scenario: Single process flush
- **WHEN** one process flushes the nursery
- **THEN** a lock directory SHALL be created at `~/.cortex/.lock/hive.lock` during flush and removed after completion

#### Scenario: Concurrent flush prevention
- **WHEN** two processes attempt to flush the nursery simultaneously
- **THEN** the second process SHALL wait (with timeout) until the first process releases the lock, then proceed with its flush

#### Scenario: Stale lock recovery
- **WHEN** a process crashes during flush leaving a stale lock
- **THEN** subsequent processes SHALL detect the stale lock (PID file check + 30s age threshold) and force-remove it before proceeding

### Requirement: Lock-free nursery append
The system SHALL NOT require a lock for appending entries to the nursery buffer. Only the flush operation (nursery → cells) requires locking.

#### Scenario: Concurrent append without lock
- **WHEN** multiple processes append to the nursery simultaneously
- **THEN** all entries SHALL be preserved without lock contention (append-only JSON operation)
