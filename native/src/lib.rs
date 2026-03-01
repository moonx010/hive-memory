mod embedding;
mod vecdb;

use embedding::Embedder;
use napi_derive::napi;
use vecdb::VecDb;

#[napi(object)]
pub struct SearchResult {
    pub id: String,
    pub distance: f64,
    pub metadata: Option<String>,
}

#[napi]
pub struct EmbedIndex {
    embedder: Embedder,
    db: VecDb,
}

#[napi]
impl EmbedIndex {
    #[napi(constructor)]
    pub fn new(db_path: String, cache_dir: String, dimension: Option<u32>) -> Self {
        let dim = dimension.unwrap_or(384) as usize;
        let embedder = Embedder::new(&cache_dir);
        let db = VecDb::open(&db_path, dim);
        Self { embedder, db }
    }

    /// Embed text for storage (passage: prefix)
    #[napi]
    pub fn embed(&self, text: String) -> Vec<f64> {
        self.embedder
            .embed_one(&text)
            .into_iter()
            .map(|f| f as f64)
            .collect()
    }

    /// Embed text for search (query: prefix)
    #[napi]
    pub fn embed_query(&self, text: String) -> Vec<f64> {
        self.embedder
            .embed_query(&text)
            .into_iter()
            .map(|f| f as f64)
            .collect()
    }

    /// Batch embed for storage
    #[napi]
    pub fn embed_batch(&self, texts: Vec<String>) -> Vec<Vec<f64>> {
        self.embedder
            .embed_many(&texts)
            .into_iter()
            .map(|v| v.into_iter().map(|f| f as f64).collect())
            .collect()
    }

    /// Add a pre-computed embedding to the index
    #[napi]
    pub fn add(&self, id: String, embedding: Vec<f64>, metadata: Option<String>) {
        let f32_vec: Vec<f32> = embedding.into_iter().map(|f| f as f32).collect();
        self.db
            .upsert(&id, &f32_vec, metadata.as_deref());
    }

    /// Search by pre-computed query embedding
    #[napi]
    pub fn search(&self, query_embedding: Vec<f64>, limit: u32) -> Vec<SearchResult> {
        let f32_vec: Vec<f32> = query_embedding.into_iter().map(|f| f as f32).collect();
        self.db
            .search(&f32_vec, limit as usize)
            .into_iter()
            .map(|r| SearchResult {
                id: r.id,
                distance: r.distance,
                metadata: r.metadata,
            })
            .collect()
    }

    /// Embed text and add to index in one call (minimizes FFI round-trips)
    #[napi]
    pub fn add_text(&self, id: String, text: String, metadata: Option<String>) {
        let embedding = self.embedder.embed_one(&text);
        self.db.upsert(&id, &embedding, metadata.as_deref());
    }

    /// Embed query and search in one call (minimizes FFI round-trips)
    #[napi]
    pub fn search_text(&self, query: String, limit: u32) -> Vec<SearchResult> {
        let query_vec = self.embedder.embed_query(&query);
        self.db
            .search(&query_vec, limit as usize)
            .into_iter()
            .map(|r| SearchResult {
                id: r.id,
                distance: r.distance,
                metadata: r.metadata,
            })
            .collect()
    }

    /// Remove a document by ID
    #[napi]
    pub fn remove(&self, id: String) {
        self.db.remove(&id);
    }

    /// Get total document count
    #[napi]
    pub fn count(&self) -> u32 {
        self.db.count() as u32
    }

    /// Close the database connection
    #[napi]
    pub fn close(&self) {
        self.db.close();
    }
}
