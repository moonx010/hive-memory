# Large-Scale Data Pipeline — Proposal

## Problem
Hive Memory lacks tooling for bulk data ingestion and long-term data management at scale:
1. No way to import historical Slack messages from Enterprise Grid exports
2. No data lifecycle management (everything stays active forever, degrading search quality)
3. No database abstraction for future backend migration

## Solution
Three focused pipeline modules:

### 1. Slack Bulk Import (`src/pipeline/slack-import.ts`)
Import Slack Enterprise Grid export directories (channels.json, users.json, per-channel day files).
Batch-inserts via SQLite transactions for performance.

### 2. Data Lifecycle Management (`src/pipeline/lifecycle.ts`)
Hot/warm/cold tiering based on entity age.
Decisions and high-signal entities are always preserved.

### 3. Database Abstraction (`src/pipeline/db-interface.ts`)
`IHiveDatabase` interface for future PostgreSQL migration path.
HiveDatabase structurally satisfies this interface.
