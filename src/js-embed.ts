import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { EmbedSearchResult } from "./embed.js";

interface VectorEntry {
  id: string;
  embedding: number[];
  metadata: string | null;
}

interface VectorsFile {
  model: string;
  dimension: number;
  vectors: VectorEntry[];
}

export class JsEmbedBackend {
  private vectors = new Map<string, VectorEntry>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pipeline: any = null;
  private filePath = "";
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  async init(dataDir: string): Promise<boolean> {
    try {
      // Dynamic import — fails if @huggingface/transformers not installed
      // Use variable to prevent TypeScript from resolving at compile time
      const moduleName = "@huggingface/transformers";
      const { pipeline } = await import(/* webpackIgnore: true */ moduleName);
      this.pipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
        dtype: "fp32",
      });

      this.filePath = join(dataDir, "vectors.json");
      if (!existsSync(dirname(this.filePath))) {
        await mkdir(dirname(this.filePath), { recursive: true });
      }

      // Load existing vectors
      if (existsSync(this.filePath)) {
        try {
          const raw = await readFile(this.filePath, "utf-8");
          const data: VectorsFile = JSON.parse(raw);
          if (data.model === "Xenova/all-MiniLM-L6-v2") {
            for (const v of data.vectors) {
              this.vectors.set(v.id, v);
            }
          }
        } catch {
          // Corrupted file — start fresh
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async addText(id: string, text: string, metadata?: string): Promise<void> {
    if (!this.pipeline) return;
    try {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true });
      const embedding: number[] = Array.from(output.data as Float32Array);

      this.vectors.set(id, {
        id,
        embedding,
        metadata: metadata ?? null,
      });

      this.dirty = true;
      this.schedulePersist();
    } catch {
      // Silently fail — never break the main flow
    }
  }

  async search(query: string, limit: number): Promise<EmbedSearchResult[]> {
    if (!this.pipeline || this.vectors.size === 0) return [];
    try {
      const output = await this.pipeline(query, { pooling: "mean", normalize: true });
      const qVec: number[] = Array.from(output.data as Float32Array);

      const scored: { id: string; distance: number; metadata: string | null }[] = [];

      for (const entry of this.vectors.values()) {
        const dot = dotProduct(qVec, entry.embedding);
        // distance = 1 - dot_product (compatible with native: 0 = identical)
        scored.push({
          id: entry.id,
          distance: 1 - dot,
          metadata: entry.metadata,
        });
      }

      scored.sort((a, b) => a.distance - b.distance);
      return scored.slice(0, limit);
    } catch {
      return [];
    }
  }

  remove(id: string): void {
    if (this.vectors.delete(id)) {
      this.dirty = true;
      this.schedulePersist();
    }
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    if (!this.pipeline) return null;
    try {
      const output = await this.pipeline(text, { pooling: "mean", normalize: true });
      return Array.from(output.data as Float32Array);
    } catch {
      return null;
    }
  }

  count(): number {
    return this.vectors.size;
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.dirty) return;

    const data: VectorsFile = {
      model: "Xenova/all-MiniLM-L6-v2",
      dimension: 384,
      vectors: [...this.vectors.values()],
    };

    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data), "utf-8");
    await rename(tmp, this.filePath);
    this.dirty = false;
  }

  async close(): Promise<void> {
    await this.flush();
    this.pipeline = null;
    this.vectors.clear();
  }

  private schedulePersist(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(() => {});
    }, 1000);
  }
}

function dotProduct(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i];
  }
  return sum;
}
