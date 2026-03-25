# Design: connector-state-machine

## SyncPhase Type

In `src/connectors/types.ts`:

```typescript
export type SyncPhase = "initial" | "incremental" | "rollback";

export interface SyncHistoryEntry {
  phase: SyncPhase;
  startedAt: string;
  completedAt?: string;
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  lastError?: string;
}
```

### ConnectorPlugin Extension

```typescript
export interface ConnectorPlugin {
  // ... existing methods ...

  /** Optional: re-sync entities from the past N hours to catch retroactive edits/deletes.
   *  Only called during ROLLBACK phase. Falls back to incrementalSync if not implemented. */
  rollbackSync?(window: { since: string; until: string }): AsyncGenerator<RawDocument>;
}
```

## ConnectorStateMachine

New file: `src/connectors/state-machine.ts`

```typescript
import type { HiveDatabase } from "../db/database.js";
import type { SyncPhase, SyncHistoryEntry } from "./types.js";

const MAX_HISTORY = 50;

export class ConnectorStateMachine {
  constructor(private db: HiveDatabase) {}

  /** Get current phase for a connector. Returns "initial" if not yet set. */
  getPhase(connectorId: string): SyncPhase {
    const connector = this.db.getConnector(connectorId);
    if (!connector) return "initial";
    return (connector.syncPhase as SyncPhase) ?? "initial";
  }

  /** Get sync history for a connector. */
  getHistory(connectorId: string): SyncHistoryEntry[] {
    const connector = this.db.getConnector(connectorId);
    if (!connector) return [];
    try {
      return JSON.parse(connector.syncHistory ?? "[]") as SyncHistoryEntry[];
    } catch {
      return [];
    }
  }

  /** Record the start of a sync run. */
  startSync(connectorId: string, phase: SyncPhase): void {
    this.db.upsertConnector({
      id: connectorId,
      connectorType: connectorId,
      config: {},
      status: "syncing",
      syncPhase: phase,
    });
  }

  /** Complete a sync run. Handles phase transitions:
   *  - initial → incremental (after successful first sync)
   *  - rollback → incremental (after rollback completes)
   *  - incremental stays incremental
   */
  completeSync(
    connectorId: string,
    result: { added: number; updated: number; skipped: number; errors: number; lastError?: string },
  ): void {
    const currentPhase = this.getPhase(connectorId);
    const nextPhase = this.resolveNextPhase(currentPhase, result.errors > 0);

    // Append to history
    const history = this.getHistory(connectorId);
    const entry: SyncHistoryEntry = {
      phase: currentPhase,
      startedAt: new Date().toISOString(), // approximation; could be tracked more precisely
      completedAt: new Date().toISOString(),
      ...result,
    };
    history.push(entry);

    // Trim to last MAX_HISTORY entries
    const trimmed = history.slice(-MAX_HISTORY);

    this.db.upsertConnector({
      id: connectorId,
      connectorType: connectorId,
      config: {},
      status: result.errors > 0 ? "error" : "idle",
      syncPhase: nextPhase,
      syncCursor: undefined, // preserved separately
      syncHistory: JSON.stringify(trimmed),
      lastSync: new Date().toISOString(),
    });
  }

  /** Determine which phase to execute based on current state. */
  getExecutionPhase(connectorId: string, forceInitial: boolean): SyncPhase {
    if (forceInitial) return "initial";
    return this.getPhase(connectorId);
  }

  private resolveNextPhase(current: SyncPhase, hadErrors: boolean): SyncPhase {
    // On errors, stay in current phase (retry next time)
    if (hadErrors) return current;

    switch (current) {
      case "initial":
        return "incremental";  // Successful first sync → move to incremental
      case "rollback":
        return "incremental";  // Rollback complete → back to incremental
      case "incremental":
        return "incremental";  // Stay in incremental
      default:
        return "incremental";
    }
  }

  /** Validate that a phase transition is legal. */
  canTransition(from: SyncPhase, to: SyncPhase): boolean {
    const valid: Record<SyncPhase, SyncPhase[]> = {
      initial: ["initial", "incremental"],      // retry or complete
      incremental: ["incremental", "rollback"],  // steady-state or rollback trigger
      rollback: ["rollback", "incremental"],      // retry or complete
    };
    return valid[from]?.includes(to) ?? false;
  }
}
```

## Refactored syncConnector()

In `src/store.ts`, the `syncConnector()` method is refactored to use the state machine:

```typescript
async syncConnector(connectorId: string, full = false): Promise<{
  added: number;
  updated: number;
  skipped: number;
  errors: number;
  lastError?: string;
}> {
  const connector = this._connectors.get(connectorId);
  if (!connector) { /* existing error handling */ }
  if (!connector.isConfigured()) { /* existing error handling */ }

  const db = this.database;
  const sm = new ConnectorStateMachine(db);

  // Determine execution phase
  const phase = sm.getExecutionPhase(connectorId, full);
  sm.startSync(connectorId, phase);

  let added = 0, updated = 0, skipped = 0, errors = 0;
  let lastError: string | undefined;
  const entityMap = new Map<string, string>();

  // Select generator based on phase
  const cursor = phase === "initial" ? undefined : connector.getCursor();
  let gen: AsyncGenerator<RawDocument>;

  switch (phase) {
    case "initial":
      gen = connector.fullSync();
      break;
    case "rollback":
      if (connector.rollbackSync) {
        const window = {
          since: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
          until: new Date().toISOString(),
        };
        gen = connector.rollbackSync(window);
      } else {
        gen = connector.incrementalSync(cursor);
      }
      break;
    case "incremental":
    default:
      gen = connector.incrementalSync(cursor);
      break;
  }

  try {
    for await (const doc of gen) {
      // ... existing transform + upsert logic with content_hash dedup ...
      // (skipped count comes from content-hash-dedup)
    }
  } catch (err) {
    // ... existing error handling ...
  }

  // Complete sync via state machine
  sm.completeSync(connectorId, { added, updated, skipped, errors, lastError });

  // ... existing postSync logic ...

  return { added, updated, skipped, errors, lastError };
}
```

## Schema Changes

Part of schema v3 migration (shared with content-hash-dedup):

```sql
ALTER TABLE connectors ADD COLUMN sync_phase TEXT NOT NULL DEFAULT 'initial';
ALTER TABLE connectors ADD COLUMN sync_history TEXT NOT NULL DEFAULT '[]';
```

## Connector Status Enhancement

In `src/tools/connector-tools.ts`, the `connector_status` tool output includes:

```typescript
{
  id: "github",
  name: "GitHub",
  status: "idle",
  syncPhase: "incremental",  // NEW
  lastSync: "2026-03-25T10:00:00Z",
  entryCount: 523,
  // When detail: "full"
  syncHistory: [
    { phase: "initial", completedAt: "2026-03-20T...", added: 520, updated: 0, skipped: 0, errors: 0 },
    { phase: "incremental", completedAt: "2026-03-25T...", added: 3, updated: 0, skipped: 520, errors: 0 },
  ]
}
```

## ConnectorRow Extension

In `src/db/database.ts`:

```typescript
interface ConnectorRow {
  id: string;
  connector_type: string;
  config: string;
  last_sync: string | null;
  status: string;
  sync_cursor: string | null;
  sync_phase: string;       // NEW
  sync_history: string;     // NEW (JSON)
}
```
