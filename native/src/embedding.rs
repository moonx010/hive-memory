use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use std::path::PathBuf;
use std::sync::OnceLock;

static EMBEDDER: OnceLock<TextEmbedding> = OnceLock::new();

fn get_or_init_embedder(cache_dir: &str) -> &'static TextEmbedding {
    EMBEDDER.get_or_init(|| {
        let options = InitOptions::new(EmbeddingModel::MultilingualE5Small)
            .with_cache_dir(PathBuf::from(cache_dir));
        TextEmbedding::try_new(options).expect("Failed to load embedding model")
    })
}

pub struct Embedder {
    cache_dir: String,
}

impl Embedder {
    pub fn new(cache_dir: &str) -> Self {
        // Eagerly initialize the model
        get_or_init_embedder(cache_dir);
        Self {
            cache_dir: cache_dir.to_string(),
        }
    }

    /// Embed text for storage (passage prefix for E5 models)
    pub fn embed_one(&self, text: &str) -> Vec<f32> {
        let prefixed = format!("passage: {}", text);
        let embedder = get_or_init_embedder(&self.cache_dir);
        let results = embedder
            .embed(vec![prefixed], None)
            .expect("Embedding failed");
        results.into_iter().next().unwrap()
    }

    /// Embed text for search queries (query prefix for E5 models)
    pub fn embed_query(&self, text: &str) -> Vec<f32> {
        let prefixed = format!("query: {}", text);
        let embedder = get_or_init_embedder(&self.cache_dir);
        let results = embedder
            .embed(vec![prefixed], None)
            .expect("Embedding failed");
        results.into_iter().next().unwrap()
    }

    /// Batch embed for storage
    pub fn embed_many(&self, texts: &[String]) -> Vec<Vec<f32>> {
        let prefixed: Vec<String> = texts.iter().map(|t| format!("passage: {}", t)).collect();
        let embedder = get_or_init_embedder(&self.cache_dir);
        embedder.embed(prefixed, None).expect("Batch embedding failed")
    }
}
