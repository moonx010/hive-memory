import type { HiveDatabase } from "../db/database.js";

export interface LifecycleConfig {
  /** Days after which active entities move to warm tier (default: 30) */
  hotDays: number;
  /** Days after which warm entities are archived (default: 365) */
  warmDays: number;
}

const DEFAULT_CONFIG: LifecycleConfig = {
  hotDays: 30,
  warmDays: 365,
};

export interface LifecycleRunResult {
  archived: number;
  hotCount: number;
  warmCount: number;
}

export interface LifecycleStats {
  total: number;
  hot: number;
  warm: number;
  archived: number;
}

export class DataLifecycleManager {
  private readonly config: LifecycleConfig;

  constructor(
    private readonly db: HiveDatabase,
    config: Partial<LifecycleConfig> = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Move old entities from active → archived based on age.
   * Decisions and tasks are preserved regardless of age.
   * Entities with high-signal attribute are also preserved.
   */
  runLifecycle(): LifecycleRunResult {
    const now = new Date();
    const warmCutoff = new Date(
      now.getTime() - this.config.warmDays * 86400000,
    ).toISOString();

    // Archive entities older than warmDays (but keep decisions, tasks, and high-signal)
    const archived = this.db.rawDb
      .prepare(
        `UPDATE entities SET status = 'archived'
         WHERE status = 'active'
           AND updated_at < ?
           AND entity_type NOT IN ('decision', 'task')
           AND JSON_EXTRACT(attributes, '$."high-signal"') IS NULL`,
      )
      .run(warmCutoff).changes;

    const hotCutoff = new Date(
      now.getTime() - this.config.hotDays * 86400000,
    ).toISOString();

    const hotRow = this.db.rawDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM entities WHERE status = 'active' AND updated_at >= ?`,
      )
      .get(hotCutoff) as { cnt: number };
    const hotCount = hotRow.cnt;
    const warmCount = this.db.countEntities({ status: "active" }) - hotCount;

    return { archived, hotCount, warmCount };
  }

  /** Get lifecycle stats across all tiers. */
  getStats(): LifecycleStats {
    const now = new Date();
    const hotCutoff = new Date(
      now.getTime() - this.config.hotDays * 86400000,
    ).toISOString();

    const total = this.db.countEntities({ status: "active" });
    const archived = this.db.countEntities({ status: "archived" });
    // Count hot entities via listEntities with since filter
    const hot = this.db.rawDb
      .prepare(
        `SELECT COUNT(*) as cnt FROM entities WHERE status = 'active' AND updated_at >= ?`,
      )
      .get(hotCutoff) as { cnt: number };
    const warm = total - hot.cnt;

    return { total, hot: hot.cnt, warm, archived };
  }
}
