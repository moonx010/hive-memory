import type { Database } from "better-sqlite3";

export const SCHEMA_VERSION = 3;

export function createSchema(db: Database): void {
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
      content_hash      TEXT
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
      sync_cursor    TEXT
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
  `);

  // v3 migration: add content_hash column to existing databases
  try {
    db.exec(`ALTER TABLE entities ADD COLUMN content_hash TEXT`);
  } catch {
    // Column already exists (fresh DB or already migrated) — safe to ignore
  }
}
