import type { Database } from "better-sqlite3";

export const SCHEMA_VERSION = 8;

export function createSchema(db: Database): void {
  // ── Schema version tracking ───────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT OR IGNORE INTO schema_meta (key, value) VALUES ('version', '${SCHEMA_VERSION}');
  `);

  // Check if already at target version — skip ALTER TABLE migrations if so
  const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get() as { value: string } | undefined;
  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : 0;

  db.exec(`
    -- ── entities ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS entities (
      id                TEXT PRIMARY KEY,
      entity_type       TEXT NOT NULL DEFAULT 'memory',
      project           TEXT,
      namespace         TEXT NOT NULL DEFAULT 'local',
      title             TEXT,
      content           TEXT NOT NULL,
      tags              TEXT NOT NULL DEFAULT '[]',
      keywords          TEXT NOT NULL DEFAULT '[]',
      attributes        TEXT NOT NULL DEFAULT '{}',
      source_system     TEXT NOT NULL DEFAULT 'agent',
      source_external_id TEXT,
      source_url        TEXT,
      source_connector  TEXT,
      author            TEXT,
      visibility        TEXT NOT NULL DEFAULT 'personal',
      domain            TEXT NOT NULL DEFAULT 'code',
      confidence        TEXT NOT NULL DEFAULT 'confirmed',
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      expires_at        TEXT,
      status            TEXT NOT NULL DEFAULT 'active',
      superseded_by     TEXT,
      content_hash      TEXT,
      owner_id          TEXT,
      required_labels   TEXT NOT NULL DEFAULT '[]',
      acl_members       TEXT NOT NULL DEFAULT '[]',
      valid_from        TEXT,
      valid_to          TEXT
    );

    -- ── FTS5 virtual table for full-text search ────────────────────────────────
    CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
      title,
      content,
      tags,
      content=entities,
      content_rowid=rowid
    );

    -- ── Triggers to keep FTS5 in sync ─────────────────────────────────────────
    CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
      INSERT INTO entities_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
      INSERT INTO entities_fts(entities_fts, rowid, title, content, tags)
        VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO entities_fts(rowid, title, content, tags)
        VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    -- ── synapses ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS synapses (
      id                TEXT PRIMARY KEY,
      source            TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target            TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      axon              TEXT NOT NULL,
      weight            REAL NOT NULL DEFAULT 0.3,
      metadata          TEXT DEFAULT '{}',
      formed_at         TEXT NOT NULL,
      last_potentiated  TEXT NOT NULL,
      UNIQUE(source, target, axon)
    );

    -- ── coactivations ─────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS coactivations (
      pair_key  TEXT PRIMARY KEY,
      count     INTEGER NOT NULL DEFAULT 1
    );

    -- ── projects ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS projects (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      path          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      tags          TEXT NOT NULL DEFAULT '[]',
      last_active   TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      one_liner     TEXT NOT NULL DEFAULT '',
      tech_stack    TEXT NOT NULL DEFAULT '[]',
      modules       TEXT NOT NULL DEFAULT '[]',
      current_focus TEXT NOT NULL DEFAULT '',
      last_session  TEXT DEFAULT NULL,
      stats         TEXT NOT NULL DEFAULT '{}'
    );

    -- ── sessions ──────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS sessions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project     TEXT NOT NULL,
      date        TEXT NOT NULL,
      summary     TEXT NOT NULL,
      next_tasks  TEXT DEFAULT '[]',
      decisions   TEXT DEFAULT '[]',
      learnings   TEXT DEFAULT '[]',
      created_at  TEXT NOT NULL
    );

    -- ── connectors ────────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS connectors (
      id             TEXT PRIMARY KEY,
      connector_type TEXT NOT NULL,
      config         TEXT NOT NULL DEFAULT '{}',
      last_sync      TEXT,
      status         TEXT DEFAULT 'idle',
      sync_cursor    TEXT,
      sync_phase     TEXT NOT NULL DEFAULT 'initial',
      sync_history   TEXT NOT NULL DEFAULT '[]'
    );

    -- ── indexes ───────────────────────────────────────────────────────────────
    CREATE INDEX IF NOT EXISTS idx_entities_project       ON entities(project);
    CREATE INDEX IF NOT EXISTS idx_entities_entity_type   ON entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_domain        ON entities(domain);
    CREATE INDEX IF NOT EXISTS idx_entities_namespace     ON entities(namespace);
    CREATE INDEX IF NOT EXISTS idx_entities_status        ON entities(status);
    CREATE INDEX IF NOT EXISTS idx_entities_created_at    ON entities(created_at);
    CREATE INDEX IF NOT EXISTS idx_entities_updated_at    ON entities(updated_at);
    CREATE INDEX IF NOT EXISTS idx_entities_expires_at    ON entities(expires_at);
    CREATE INDEX IF NOT EXISTS idx_entities_project_type  ON entities(project, entity_type);
    CREATE INDEX IF NOT EXISTS idx_entities_project_status ON entities(project, status);

    CREATE INDEX IF NOT EXISTS idx_synapses_source        ON synapses(source);
    CREATE INDEX IF NOT EXISTS idx_synapses_target        ON synapses(target);
    CREATE INDEX IF NOT EXISTS idx_synapses_axon          ON synapses(axon);
    CREATE INDEX IF NOT EXISTS idx_synapses_weight        ON synapses(weight);

    CREATE INDEX IF NOT EXISTS idx_sessions_project       ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_date          ON sessions(date);
    CREATE INDEX IF NOT EXISTS idx_sessions_created_at    ON sessions(created_at);

    CREATE INDEX IF NOT EXISTS idx_connectors_type        ON connectors(connector_type);
    CREATE INDEX IF NOT EXISTS idx_connectors_status      ON connectors(status);

    -- ── entity_aliases (v2) ─────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS entity_aliases (
      id              TEXT PRIMARY KEY,
      canonical_id    TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      alias_system    TEXT NOT NULL,
      alias_value     TEXT NOT NULL,
      alias_type      TEXT NOT NULL CHECK(alias_type IN ('external_id','email','name','handle')),
      confidence      TEXT NOT NULL DEFAULT 'inferred'
                      CHECK(confidence IN ('confirmed','inferred')),
      created_at      TEXT NOT NULL,
      UNIQUE(alias_system, alias_value)
    );

    CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical_id);
    CREATE INDEX IF NOT EXISTS idx_entities_source_ext ON entities(source_system, source_external_id);

    -- ── users (v4) ───────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS users (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      email        TEXT UNIQUE,
      api_key_hash TEXT NOT NULL UNIQUE,
      role         TEXT NOT NULL DEFAULT 'member',
      created_at   TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_users_api_key_hash ON users(api_key_hash);
    CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

    -- ── organizations (v7) ───────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active'
    );

    -- ── workspaces (v7) ──────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL REFERENCES organizations(id),
      name       TEXT NOT NULL,
      slug       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'active',
      UNIQUE(org_id, slug)
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(org_id);

    -- ── audit_log (v8) ────────────────────────────────────────────────────────
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      user_id TEXT,
      action TEXT NOT NULL,
      tool_name TEXT,
      resource_id TEXT,
      query TEXT,
      result_count INTEGER,
      ip_address TEXT,
      metadata TEXT DEFAULT '{}'
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id);

    -- Tamper protection: prevent DELETE/UPDATE on audit_log
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON audit_log BEGIN
        SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
      END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON audit_log BEGIN
        SELECT RAISE(ABORT, 'Audit log entries cannot be modified');
      END;
  `);

  // Run column migrations only when upgrading from an older schema version
  if (currentVersion < 3) {
    // v3 migration: add content_hash column to existing databases
    try {
      db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`);
    } catch {
      // Column already exists — safe to ignore
    }

    // v3 migration: add sync_phase and sync_history columns to connectors table
    try {
      db.exec(`ALTER TABLE connectors ADD COLUMN sync_phase TEXT NOT NULL DEFAULT 'initial'`);
    } catch {
      // Column already exists — safe to ignore
    }
    try {
      db.exec(`ALTER TABLE connectors ADD COLUMN sync_history TEXT NOT NULL DEFAULT '[]'`);
    } catch {
      // Column already exists — safe to ignore
    }
  } else {
    // Fresh DB or already at v3+: ensure columns exist via safe try/catch
    try { db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE connectors ADD COLUMN sync_phase TEXT NOT NULL DEFAULT 'initial'`); } catch { /* exists */ }
    try { db.exec(`ALTER TABLE connectors ADD COLUMN sync_history TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
  }

  // v5 migration: ACL columns
  try { db.exec(`ALTER TABLE entities ADD COLUMN owner_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE entities ADD COLUMN required_labels TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE entities ADD COLUMN acl_members TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
  try { db.exec(`UPDATE entities SET visibility = 'private' WHERE visibility = 'personal'`); } catch { /* no rows */ }

  // v5: labels + user_labels tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_labels (
      user_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      granted_by TEXT,
      granted_at TEXT NOT NULL,
      PRIMARY KEY (user_id, label_id)
    );

    CREATE INDEX IF NOT EXISTS idx_user_labels_user ON user_labels(user_id);
    CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
  `);

  // v5: partial index for label-free entities (performance)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_no_labels ON entities(id) WHERE required_labels = '[]'`); } catch { /* exists */ }

  // v5: revoked_at on users
  try { db.exec(`ALTER TABLE users ADD COLUMN revoked_at TEXT`); } catch { /* exists */ }

  // v6: temporal validity columns
  try { db.exec(`ALTER TABLE entities ADD COLUMN valid_from TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE entities ADD COLUMN valid_to TEXT`); } catch { /* exists */ }
  // Backfill: set valid_from = created_at for existing entities that lack it
  try { db.exec(`UPDATE entities SET valid_from = created_at WHERE valid_from IS NULL`); } catch { /* no rows */ }

  // v6: index for temporal validity queries
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_valid_from ON entities(valid_from)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_valid_to ON entities(valid_to)`); } catch { /* exists */ }

  // v7: multi-tenancy columns
  try { db.exec(`ALTER TABLE users ADD COLUMN org_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE users ADD COLUMN workspace_id TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE entities ADD COLUMN org_id TEXT`); } catch { /* exists */ }

  // v7: index for tenant-scoped entity queries
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_org ON entities(org_id)`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id)`); } catch { /* exists */ }

  // Update schema_meta version to current
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('version', ?)").run(String(SCHEMA_VERSION));
}
