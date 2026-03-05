import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, arch } from "node:os";
import { JsEmbedBackend } from "./js-embed.js";

interface NativeSearchResult {
  id: string;
  distance: number;
  metadata: string | null;
}

interface NativeEmbedIndex {
  addText(id: string, text: string, metadata?: string): void;
  searchText(query: string, limit: number): NativeSearchResult[];
  remove(id: string): void;
  count(): number;
  close(): void;
}

interface NativeModule {
  EmbedIndex: new (
    dbPath: string,
    cacheDir: string,
    dimension?: number,
  ) => NativeEmbedIndex;
}

export interface EmbedSearchResult {
  id: string;
  distance: number;
  metadata: string | null;
}

type BackendType = "native" | "js" | "none";

export class EmbedService {
  private nativeIndex: NativeEmbedIndex | null = null;
  private jsBackend: JsEmbedBackend | null = null;
  public available = false;

  get backend(): BackendType {
    if (this.nativeIndex) return "native";
    if (this.jsBackend) return "js";
    return "none";
  }

  async init(dataDir: string): Promise<void> {
    // Priority 1: Native Rust module
    if (await this.tryNative(dataDir)) {
      // Also init JS backend for getEmbedding() — native doesn't expose raw vectors
      await this.tryJs(dataDir);
      return;
    }

    // Priority 2: JS (transformers.js)
    if (await this.tryJs(dataDir)) return;

    // Priority 3: No embedding — keyword-only
    this.available = false;
  }

  private async tryNative(dataDir: string): Promise<boolean> {
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const projectRoot = dirname(thisDir); // up from src/ or dist/
      const nodeName = `cortex-embed.${platform()}-${arch()}.node`;
      const nativePath = join(projectRoot, "native", nodeName);

      if (!existsSync(nativePath)) return false;

      const require = createRequire(import.meta.url);
      const mod = require(nativePath) as NativeModule;
      const dbPath = join(dataDir, "embeddings.db");
      const cacheDir = join(dataDir, "models");
      this.nativeIndex = new mod.EmbedIndex(dbPath, cacheDir, 384);
      this.available = true;
      return true;
    } catch {
      return false;
    }
  }

  private async tryJs(dataDir: string): Promise<boolean> {
    try {
      const backend = new JsEmbedBackend();
      const ok = await backend.init(dataDir);
      if (ok) {
        this.jsBackend = backend;
        this.available = true;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  async addText(id: string, text: string, metadata?: string): Promise<void> {
    if (this.nativeIndex) {
      try {
        this.nativeIndex.addText(id, text, metadata);
        return;
      } catch {
        // Native failed — fall through to JS backend
      }
    }
    if (this.jsBackend) {
      await this.jsBackend.addText(id, text, metadata);
    }
  }

  async search(query: string, limit: number): Promise<EmbedSearchResult[]> {
    if (this.nativeIndex) {
      try {
        return this.nativeIndex.searchText(query, limit);
      } catch {
        return [];
      }
    }
    if (this.jsBackend) {
      return this.jsBackend.search(query, limit);
    }
    return [];
  }

  async getEmbedding(text: string): Promise<number[] | null> {
    if (this.jsBackend) {
      return this.jsBackend.getEmbedding(text);
    }
    return null;
  }

  async remove(id: string): Promise<void> {
    if (this.nativeIndex) {
      try {
        this.nativeIndex.remove(id);
        return;
      } catch {
        // Native failed — fall through to JS backend
      }
    }
    if (this.jsBackend) {
      this.jsBackend.remove(id);
    }
  }

  count(): number {
    if (this.nativeIndex) {
      try {
        return this.nativeIndex.count();
      } catch {
        return 0;
      }
    }
    if (this.jsBackend) {
      return this.jsBackend.count();
    }
    return 0;
  }

  async close(): Promise<void> {
    if (this.nativeIndex) {
      try {
        this.nativeIndex.close();
        this.nativeIndex = null;
      } catch {
        // Silently fail
      }
    }
    if (this.jsBackend) {
      await this.jsBackend.close();
      this.jsBackend = null;
    }
  }
}
