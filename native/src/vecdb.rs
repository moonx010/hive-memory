use rusqlite::{ffi::sqlite3_auto_extension, params, Connection};
use serde::{Deserialize, Serialize};
use sqlite_vec::sqlite3_vec_init;
use std::sync::{Mutex, Once};

static VEC_INIT: Once = Once::new();

#[derive(Debug, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub distance: f64,
    pub metadata: Option<String>,
}

pub struct VecDb {
    conn: Mutex<Option<Connection>>,
    #[allow(dead_code)]
    dim: usize,
}

impl VecDb {
    pub fn open(path: &str, dim: usize) -> Self {
        // Register sqlite-vec as auto-extension (once, before opening)
        VEC_INIT.call_once(|| unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite3_vec_init as *const (),
            )));
        });

        let conn = Connection::open(path).expect("Failed to open sqlite db");

        // Create tables
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS documents (
                id TEXT PRIMARY KEY,
                metadata TEXT
            );
            CREATE TABLE IF NOT EXISTS id_map (
                string_id TEXT PRIMARY KEY,
                rowid_val INTEGER UNIQUE
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_documents USING vec0(
                embedding float[{dim}]
            );"
        ))
        .expect("Failed to create tables");

        Self {
            conn: Mutex::new(Some(conn)),
            dim,
        }
    }

    pub fn upsert(&self, id: &str, embedding: &[f32], metadata: Option<&str>) {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().expect("DB is closed");

        // Check if id already exists
        let existing_rowid: Option<i64> = conn
            .query_row(
                "SELECT rowid_val FROM id_map WHERE string_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();

        if let Some(rowid) = existing_rowid {
            // Update existing
            conn.execute(
                "UPDATE documents SET metadata = ?1 WHERE id = ?2",
                params![metadata, id],
            )
            .unwrap();

            let blob = embedding_to_blob(embedding);
            conn.execute(
                "UPDATE vec_documents SET embedding = ?1 WHERE rowid = ?2",
                params![blob, rowid],
            )
            .unwrap();
        } else {
            // Insert new
            conn.execute(
                "INSERT INTO documents (id, metadata) VALUES (?1, ?2)",
                params![id, metadata],
            )
            .unwrap();

            let blob = embedding_to_blob(embedding);
            conn.execute(
                "INSERT INTO vec_documents (embedding) VALUES (?1)",
                params![blob],
            )
            .unwrap();

            let rowid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO id_map (string_id, rowid_val) VALUES (?1, ?2)",
                params![id, rowid],
            )
            .unwrap();
        }
    }

    pub fn search(&self, query_vec: &[f32], limit: usize) -> Vec<SearchResult> {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().expect("DB is closed");

        let blob = embedding_to_blob(query_vec);
        let mut stmt = conn
            .prepare(
                "SELECT
                    im.string_id,
                    v.distance,
                    d.metadata
                FROM vec_documents v
                JOIN id_map im ON im.rowid_val = v.rowid
                JOIN documents d ON d.id = im.string_id
                WHERE v.embedding MATCH ?1
                AND k = ?2
                ORDER BY v.distance",
            )
            .unwrap();

        let results = stmt
            .query_map(params![blob, limit as i64], |row| {
                Ok(SearchResult {
                    id: row.get(0)?,
                    distance: row.get(1)?,
                    metadata: row.get(2)?,
                })
            })
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        results
    }

    pub fn remove(&self, id: &str) {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().expect("DB is closed");

        let rowid: Option<i64> = conn
            .query_row(
                "SELECT rowid_val FROM id_map WHERE string_id = ?1",
                params![id],
                |row| row.get(0),
            )
            .ok();

        if let Some(rowid) = rowid {
            conn.execute("DELETE FROM vec_documents WHERE rowid = ?1", params![rowid])
                .unwrap();
            conn.execute("DELETE FROM id_map WHERE string_id = ?1", params![id])
                .unwrap();
            conn.execute("DELETE FROM documents WHERE id = ?1", params![id])
                .unwrap();
        }
    }

    pub fn count(&self) -> usize {
        let guard = self.conn.lock().unwrap();
        let conn = guard.as_ref().expect("DB is closed");

        conn.query_row("SELECT COUNT(*) FROM documents", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize
    }

    pub fn close(&self) {
        let mut guard = self.conn.lock().unwrap();
        *guard = None;
    }
}

fn embedding_to_blob(embedding: &[f32]) -> Vec<u8> {
    embedding
        .iter()
        .flat_map(|f| f.to_le_bytes())
        .collect()
}
