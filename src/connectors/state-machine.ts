import type { HiveDatabase } from "../db/database.js";
import type { SyncPhase, SyncHistoryEntry } from "./types.js";

const MAX_HISTORY = 50;
const DEFAULT_ROLLBACK_FREQUENCY = 5; // every 5th incremental sync
const DEFAULT_ROLLBACK_WINDOW_HOURS = 6;

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
    const existing = this.db.getConnector(connectorId);
    this.db.upsertConnector({
      id: connectorId,
      connectorType: existing?.connectorType ?? connectorId,
      config: existing?.config ?? {},
      lastSync: existing?.lastSync,
      status: "syncing",
      syncCursor: existing?.syncCursor,
      syncPhase: phase,
      syncHistory: existing?.syncHistory ?? "[]",
    });
  }

  /** Complete a sync run. Handles phase transitions:
   *  - initial → incremental (after successful first sync)
   *  - rollback → incremental (after rollback completes)
   *  - incremental stays incremental
   *  - on errors, stays in current phase (retry next time)
   */
  completeSync(
    connectorId: string,
    result: { added: number; updated: number; skipped: number; errors: number; lastError?: string },
    opts: { lastSync?: string; syncCursor?: string } = {},
  ): void {
    const currentPhase = this.getPhase(connectorId);
    const nextPhase = this.resolveNextPhase(currentPhase, result.errors > 0);

    // Append to history
    const history = this.getHistory(connectorId);
    const now = new Date().toISOString();
    const entry: SyncHistoryEntry = {
      phase: currentPhase,
      startedAt: now,
      completedAt: now,
      added: result.added,
      updated: result.updated,
      skipped: result.skipped,
      errors: result.errors,
      lastError: result.lastError,
    };
    history.push(entry);

    // Trim to last MAX_HISTORY entries
    const trimmed = history.slice(-MAX_HISTORY);

    const existing = this.db.getConnector(connectorId);
    this.db.upsertConnector({
      id: connectorId,
      connectorType: existing?.connectorType ?? connectorId,
      config: existing?.config ?? {},
      lastSync: opts.lastSync ?? new Date().toISOString(),
      status: result.errors > 0 ? "error" : "idle",
      syncCursor: opts.syncCursor ?? existing?.syncCursor,
      syncPhase: nextPhase,
      syncHistory: JSON.stringify(trimmed),
    });
  }

  /** Determine which phase to execute based on current state.
   *  When in incremental phase, automatically injects a rollback every N syncs. */
  getExecutionPhase(connectorId: string, forceInitial: boolean): SyncPhase {
    if (forceInitial) return "initial";

    const phase = this.getPhase(connectorId);
    if (phase !== "incremental") return phase;

    // Check if it's time for a rollback
    if (this.shouldRollback(connectorId)) {
      return "rollback";
    }

    return "incremental";
  }

  /** Get the rollback window timestamps based on CORTEX_ROLLBACK_WINDOW_HOURS env var. */
  getRollbackWindow(): { since: string; until: string } {
    const hours = parseInt(
      process.env.CORTEX_ROLLBACK_WINDOW_HOURS ?? String(DEFAULT_ROLLBACK_WINDOW_HOURS),
      10,
    );
    const now = new Date();
    const since = new Date(now.getTime() - hours * 60 * 60 * 1000);
    return { since: since.toISOString(), until: now.toISOString() };
  }

  private shouldRollback(connectorId: string): boolean {
    const freq = parseInt(
      process.env.CORTEX_ROLLBACK_FREQUENCY ?? String(DEFAULT_ROLLBACK_FREQUENCY),
      10,
    );
    if (freq <= 0) return false; // disabled

    const history = this.getHistory(connectorId);
    const incrementalsSinceLastRollback = this.countIncrementalsSinceLastRollback(history);
    return incrementalsSinceLastRollback >= freq;
  }

  private countIncrementalsSinceLastRollback(history: SyncHistoryEntry[]): number {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].phase === "rollback") break;
      if (history[i].phase === "incremental") count++;
    }
    return count;
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
}
