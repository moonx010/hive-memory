/**
 * Embedder abstraction — converts text to fixed-dimension float vectors.
 *
 * Providers:
 *   - "local"  — @huggingface/transformers (Xenova/all-MiniLM-L6-v2, dim=384)
 *   - "openai" — OpenAI text-embedding-3-small (dim=1536, or configured dim)
 *   - "none"   — no-op; returns null embeddings (default, backward-compat)
 *
 * Controlled by env:
 *   CORTEX_EMBEDDING_PROVIDER = "local" | "openai" | "none"
 *   CORTEX_EMBEDDING_MODEL    = model name override
 *   CORTEX_EMBEDDING_API_KEY  = API key for OpenAI
 */

export interface Embedder {
  embed(text: string): Promise<Float32Array | null>;
  embedBatch(texts: string[]): Promise<Array<Float32Array | null>>;
  readonly dimensions: number;
  readonly isAvailable: boolean;
}

// ── Local embedder (transformers.js) ──────────────────────────────────────────

export class LocalEmbedder implements Embedder {
  readonly dimensions = 384;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pipeline: any = null;
  private _ready = false;
  private _initPromise: Promise<void> | null = null;

  get isAvailable(): boolean {
    return this._ready;
  }

  async init(): Promise<boolean> {
    if (this._initPromise) {
      await this._initPromise;
      return this._ready;
    }
    this._initPromise = this._doInit();
    await this._initPromise;
    return this._ready;
  }

  private async _doInit(): Promise<void> {
    try {
      const modelName =
        process.env.CORTEX_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";
      // Dynamic import prevents TypeScript from resolving at compile time
      const moduleName = "@huggingface/transformers";
      const { pipeline } = await import(/* webpackIgnore: true */ moduleName);
      this._pipeline = await pipeline("feature-extraction", modelName, {
        dtype: "fp32",
      });
      this._ready = true;
    } catch {
      this._ready = false;
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this._ready) return null;
    try {
      const output = await this._pipeline(text, {
        pooling: "mean",
        normalize: true,
      });
      return new Float32Array(output.data as Float32Array);
    } catch {
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

// ── OpenAI embedder ───────────────────────────────────────────────────────────

export class OpenAIEmbedder implements Embedder {
  private apiKey: string;
  private model: string;
  readonly dimensions: number;
  private _available = false;

  constructor() {
    this.apiKey =
      process.env.CORTEX_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    this.model =
      process.env.CORTEX_EMBEDDING_MODEL ?? "text-embedding-3-small";
    // text-embedding-3-small produces 1536 dims; ada-002 is also 1536
    this.dimensions = 1536;
  }

  get isAvailable(): boolean {
    return this._available;
  }

  async init(): Promise<boolean> {
    this._available = this.apiKey.length > 0;
    return this._available;
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this._available) return null;
    try {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: text, model: this.model }),
      });
      if (!resp.ok) return null;
      const json = (await resp.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      return new Float32Array(json.data[0].embedding);
    } catch {
      return null;
    }
  }

  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    if (!this._available) return texts.map(() => null);
    try {
      const resp = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ input: texts, model: this.model }),
      });
      if (!resp.ok) return texts.map(() => null);
      const json = (await resp.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
      };
      const sorted = json.data.sort((a, b) => a.index - b.index);
      return sorted.map((d) => new Float32Array(d.embedding));
    } catch {
      return texts.map(() => null);
    }
  }
}

// ── No-op embedder ────────────────────────────────────────────────────────────

class NoneEmbedder implements Embedder {
  readonly dimensions = 0;
  readonly isAvailable = false;
  async embed(_text: string): Promise<Float32Array | null> {
    return null;
  }
  async embedBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    return texts.map(() => null);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

let _cachedEmbedder: Embedder | null = null;

/**
 * Create and cache the embedder based on CORTEX_EMBEDDING_PROVIDER.
 * Default is "none" for backward compatibility.
 */
export async function createEmbedder(): Promise<Embedder> {
  if (_cachedEmbedder) return _cachedEmbedder;

  const provider = process.env.CORTEX_EMBEDDING_PROVIDER ?? "none";

  if (provider === "openai") {
    const embedder = new OpenAIEmbedder();
    await embedder.init();
    _cachedEmbedder = embedder;
    return embedder;
  }

  if (provider === "local") {
    const embedder = new LocalEmbedder();
    await embedder.init();
    _cachedEmbedder = embedder;
    return embedder;
  }

  _cachedEmbedder = new NoneEmbedder();
  return _cachedEmbedder;
}

/** Reset cached embedder (primarily for testing). */
export function resetEmbedderCache(): void {
  _cachedEmbedder = null;
}
