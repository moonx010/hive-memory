import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { acquireLock, releaseLock } from "./lock.js";
import type {
  HiveIndex,
  HiveCellData,
  CellEntry,
  DirectEntry,
  ReferenceEntry,
  MemoryCategory,
  MemoryEntry,
} from "../types.js";
import { readJson, writeJson } from "./io.js";
import {
  extractKeywords,
  keywordOverlap,
  keywordSplit2,
  generateCellId,
  getEntryText,
} from "./hive-index.js";

const NURSERY_FLUSH_THRESHOLD = 10;
const CELL_SPLIT_THRESHOLD = 20;

export class HiveStore {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  private get hivePath(): string {
    return join(this.dataDir, "hive.json");
  }

  private get cellsDir(): string {
    return join(this.dataDir, "cells");
  }

  async ensureDirs(): Promise<void> {
    if (!existsSync(this.cellsDir)) {
      await mkdir(this.cellsDir, { recursive: true });
    }
  }

  async loadHive(): Promise<HiveIndex> {
    if (!existsSync(this.hivePath)) {
      return { version: 1, cells: {}, nursery: [], totalEntries: 0 };
    }
    return readJson<HiveIndex>(this.hivePath);
  }

  async saveHive(hive: HiveIndex): Promise<void> {
    await writeJson(this.hivePath, hive);
  }

  async loadCellData(cellId: string): Promise<HiveCellData> {
    const path = join(this.cellsDir, `${cellId}.json`);
    if (!existsSync(path)) {
      return { cellId, entries: [] };
    }
    return readJson<HiveCellData>(path);
  }

  async saveCellData(data: HiveCellData): Promise<void> {
    await this.ensureDirs();
    const path = join(this.cellsDir, `${data.cellId}.json`);
    await writeJson(path, data);
  }

  async storeDirectEntry(
    projectId: string,
    category: MemoryCategory,
    content: string,
    tags: string[],
    agentId?: string,
  ): Promise<MemoryEntry> {
    const now = new Date().toISOString();

    const entry: DirectEntry = {
      type: "direct",
      id: randomUUID(),
      project: projectId,
      category,
      content,
      tags,
      createdAt: now,
      ...(agentId ? { agentId } : {}),
    };

    const hive = await this.loadHive();
    hive.nursery.push(entry);
    hive.totalEntries++;

    if (hive.nursery.length >= NURSERY_FLUSH_THRESHOLD) {
      await this.flushNursery(hive);
    }

    await this.saveHive(hive);

    return {
      id: entry.id,
      project: entry.project,
      category: entry.category,
      content: entry.content,
      tags: entry.tags,
      createdAt: entry.createdAt,
    };
  }

  async storeReferenceEntry(
    projectId: string,
    path: string,
    source: string,
    description: string,
    tags: string[],
  ): Promise<ReferenceEntry> {
    const now = new Date().toISOString();

    const entry: ReferenceEntry = {
      type: "reference",
      id: randomUUID(),
      project: projectId,
      path,
      source,
      description,
      tags,
      createdAt: now,
      lastSynced: now,
    };

    const hive = await this.loadHive();
    hive.nursery.push(entry);
    hive.totalEntries++;

    if (hive.nursery.length >= NURSERY_FLUSH_THRESHOLD) {
      await this.flushNursery(hive);
    }

    await this.saveHive(hive);
    return entry;
  }

  async flushNursery(hive: HiveIndex): Promise<void> {
    if (hive.nursery.length === 0) return;

    await acquireLock(this.dataDir);
    try {
      await this.doFlush(hive);
    } finally {
      await releaseLock(this.dataDir);
    }
  }

  private async doFlush(hive: HiveIndex): Promise<void> {
    await this.ensureDirs();

    const leafIds = Object.keys(hive.cells).filter(
      (id) => hive.cells[id].type === "leaf",
    );

    // If no cells exist yet, create one from all nursery entries
    if (leafIds.length === 0) {
      const allText = hive.nursery.map(getEntryText).join(" ");
      const cellId = generateCellId(allText);

      hive.cells[cellId] = {
        id: cellId,
        type: "leaf",
        summary: allText.slice(0, 200),
        keywords: extractKeywords(allText),
        count: hive.nursery.length,
      };

      await this.saveCellData({ cellId, entries: [...hive.nursery] });
      hive.nursery = [];
      return;
    }

    // Assign each nursery entry to the best matching leaf (by keyword overlap)
    const assignments = new Map<string, CellEntry[]>();
    for (const leafId of leafIds) {
      assignments.set(leafId, []);
    }

    for (const entry of hive.nursery) {
      let bestLeaf = leafIds[0];
      let bestScore = -Infinity;
      const entryKeywords = extractKeywords(getEntryText(entry));

      for (const leafId of leafIds) {
        const cell = hive.cells[leafId];
        const score = keywordOverlap(entryKeywords, cell.keywords);
        if (score > bestScore) {
          bestScore = score;
          bestLeaf = leafId;
        }
      }

      assignments.get(bestLeaf)!.push(entry);
    }

    hive.nursery = [];

    // Append entries to their assigned cells
    for (const [leafId, entries] of assignments) {
      if (entries.length === 0) continue;

      const cellData = await this.loadCellData(leafId);
      cellData.entries.push(...entries);

      // Update cell metadata
      const cell = hive.cells[leafId];
      cell.count = cellData.entries.length;
      const allText = cellData.entries.map(getEntryText).join(" ");
      cell.keywords = extractKeywords(allText);
      cell.summary = allText.slice(0, 200);

      await this.saveCellData(cellData);

      // Split if too large
      if (cellData.entries.length > CELL_SPLIT_THRESHOLD) {
        await this.splitCell(hive, leafId, cellData);
      }
    }
  }

  async splitCell(
    hive: HiveIndex,
    cellId: string,
    cellData: HiveCellData,
  ): Promise<void> {
    if (cellData.entries.length < 4) return;

    const [groupA, groupB] = keywordSplit2(cellData.entries);

    if (groupA.length === 0 || groupB.length === 0) return;

    const entriesA = groupA.map((i) => cellData.entries[i]);
    const entriesB = groupB.map((i) => cellData.entries[i]);

    const textA = entriesA.map(getEntryText).join(" ");
    const textB = entriesB.map(getEntryText).join(" ");

    const childIdA = generateCellId(textA);
    const childIdB = generateCellId(textB);

    hive.cells[childIdA] = {
      id: childIdA,
      type: "leaf",
      summary: textA.slice(0, 200),
      keywords: extractKeywords(textA),
      count: entriesA.length,
    };

    hive.cells[childIdB] = {
      id: childIdB,
      type: "leaf",
      summary: textB.slice(0, 200),
      keywords: extractKeywords(textB),
      count: entriesB.length,
    };

    // Replace the original leaf with a branch
    const oldCell = hive.cells[cellId];
    hive.cells[cellId] = {
      id: cellId,
      type: "branch",
      summary: oldCell.summary,
      keywords: oldCell.keywords,
      count: oldCell.count,
      children: [childIdA, childIdB],
    };

    await this.saveCellData({ cellId: childIdA, entries: entriesA });
    await this.saveCellData({ cellId: childIdB, entries: entriesB });
  }

  /**
   * Get all entries across nursery and all leaf cells.
   */
  async getAllEntries(): Promise<CellEntry[]> {
    const hive = await this.loadHive();
    const entries: CellEntry[] = [...hive.nursery];

    const leafIds = Object.keys(hive.cells).filter(
      (id) => hive.cells[id].type === "leaf",
    );

    for (const leafId of leafIds) {
      const cellData = await this.loadCellData(leafId);
      entries.push(...cellData.entries);
    }

    return entries;
  }

  /**
   * Get recent entries from nursery (for temporal synapse creation).
   */
  async getNurseryEntries(): Promise<CellEntry[]> {
    const hive = await this.loadHive();
    return [...hive.nursery];
  }

  /**
   * Remove entries matching a predicate from nursery and all leaf cells.
   */
  async removeEntries(predicate: (entry: CellEntry) => boolean): Promise<number> {
    const hive = await this.loadHive();

    // Remove from nursery
    const origNurseryLen = hive.nursery.length;
    hive.nursery = hive.nursery.filter((e) => !predicate(e));
    let totalRemoved = origNurseryLen - hive.nursery.length;

    // Remove from leaf cells
    const leafIds = Object.keys(hive.cells).filter(
      (id) => hive.cells[id].type === "leaf",
    );

    for (const leafId of leafIds) {
      const cellData = await this.loadCellData(leafId);
      const origLen = cellData.entries.length;
      cellData.entries = cellData.entries.filter((e) => !predicate(e));
      const removed = origLen - cellData.entries.length;
      if (removed > 0) {
        totalRemoved += removed;
        hive.cells[leafId].count = cellData.entries.length;
        await this.saveCellData(cellData);
      }
    }

    hive.totalEntries -= totalRemoved;
    await this.saveHive(hive);
    return totalRemoved;
  }

  /**
   * Remove all reference entries for a given project and source.
   */
  async removeReferences(projectId: string, source?: string): Promise<void> {
    const hive = await this.loadHive();

    // Remove from nursery
    const origNurseryLen = hive.nursery.length;
    hive.nursery = hive.nursery.filter(
      (e) =>
        !(
          e.type === "reference" &&
          e.project === projectId &&
          (!source || e.source === source)
        ),
    );

    // Remove from leaf cells
    const leafIds = Object.keys(hive.cells).filter(
      (id) => hive.cells[id].type === "leaf",
    );

    let totalRemoved = origNurseryLen - hive.nursery.length;

    for (const leafId of leafIds) {
      const cellData = await this.loadCellData(leafId);
      const origLen = cellData.entries.length;
      cellData.entries = cellData.entries.filter(
        (e) =>
          !(
            e.type === "reference" &&
            e.project === projectId &&
            (!source || e.source === source)
          ),
      );
      const removed = origLen - cellData.entries.length;
      if (removed > 0) {
        totalRemoved += removed;
        hive.cells[leafId].count = cellData.entries.length;
        await this.saveCellData(cellData);
      }
    }

    hive.totalEntries -= totalRemoved;
    await this.saveHive(hive);
  }
}
