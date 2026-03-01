import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { platform, arch } from "node:os";

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

export class EmbedService {
  private index: NativeEmbedIndex | null = null;
  public available = false;

  async init(dataDir: string): Promise<void> {
    try {
      const thisDir = dirname(fileURLToPath(import.meta.url));
      const projectRoot = dirname(thisDir); // up from src/ or dist/
      const nodeName = `cortex-embed.${platform()}-${arch()}.node`;
      const nativePath = join(projectRoot, "native", nodeName);

      if (!existsSync(nativePath)) {
        this.available = false;
        return;
      }

      // Use createRequire for .node native addons (ESM import doesn't work for them)
      const require = createRequire(import.meta.url);
      const mod = require(nativePath) as NativeModule;
      const dbPath = join(dataDir, "embeddings.db");
      const cacheDir = join(dataDir, "models");
      this.index = new mod.EmbedIndex(dbPath, cacheDir, 384);
      this.available = true;
    } catch {
      // Native module not available — fall back to keyword search
      this.available = false;
    }
  }

  addText(id: string, text: string, metadata?: string): void {
    if (!this.index) return;
    try {
      this.index.addText(id, text, metadata);
    } catch {
      // Silently fail — never break the main flow
    }
  }

  search(query: string, limit: number): EmbedSearchResult[] {
    if (!this.index) return [];
    try {
      return this.index.searchText(query, limit);
    } catch {
      return [];
    }
  }

  remove(id: string): void {
    if (!this.index) return;
    try {
      this.index.remove(id);
    } catch {
      // Silently fail
    }
  }

  count(): number {
    if (!this.index) return 0;
    try {
      return this.index.count();
    } catch {
      return 0;
    }
  }

  close(): void {
    if (!this.index) return;
    try {
      this.index.close();
      this.index = null;
    } catch {
      // Silently fail
    }
  }
}
