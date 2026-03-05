import { describe, it, expect } from "vitest";
import {
  computeCentroid,
  cosineSim,
  extractKeywords,
  keywordOverlap,
  kMeans2,
  generateCellId,
  getEntryText,
} from "../src/store/hive-index.js";
import type { DirectEntry, ReferenceEntry } from "../src/types.js";

describe("computeCentroid", () => {
  it("returns empty array for empty input", () => {
    expect(computeCentroid([])).toEqual([]);
  });

  it("returns the vector itself for a single vector", () => {
    expect(computeCentroid([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it("computes mean of multiple vectors", () => {
    const result = computeCentroid([[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
    expect(result).toHaveLength(3);
    for (const v of result) {
      expect(v).toBeCloseTo(1 / 3, 5);
    }
  });
});

describe("cosineSim", () => {
  it("returns 0 for empty vectors", () => {
    expect(cosineSim([], [])).toBe(0);
  });

  it("returns 1 for identical vectors", () => {
    const v = [1, 0, 0];
    expect(cosineSim(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSim([1, 0], [0, 1])).toBeCloseTo(0, 5);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSim([1, 0], [-1, 0])).toBeCloseTo(-1, 5);
  });

  it("handles non-unit vectors", () => {
    expect(cosineSim([2, 0], [4, 0])).toBeCloseTo(1, 5);
  });
});

describe("extractKeywords", () => {
  it("extracts meaningful words and removes stop words", () => {
    const keywords = extractKeywords("Use JWT tokens for service-to-service authentication");
    expect(keywords).toContain("jwt");
    expect(keywords).toContain("tokens");
    expect(keywords).toContain("authentication");
    expect(keywords).not.toContain("for");
    expect(keywords).not.toContain("to");
  });

  it("returns top 10 by frequency", () => {
    const text = "database database database query query index";
    const keywords = extractKeywords(text);
    expect(keywords[0]).toBe("database");
    expect(keywords[1]).toBe("query");
  });

  it("filters short words", () => {
    const keywords = extractKeywords("a an is my go db");
    // "db" is 2 chars, should be excluded
    expect(keywords).not.toContain("db");
  });

  it("extracts Korean keywords", () => {
    const keywords = extractKeywords("데이터베이스 설계 결정사항 인증 시스템");
    expect(keywords).toContain("데이터베이스");
    expect(keywords).toContain("설계");
    expect(keywords).toContain("인증");
  });

  it("handles mixed Korean and English", () => {
    const keywords = extractKeywords("React 컴포넌트 구조 설계 TypeScript");
    expect(keywords).toContain("react");
    expect(keywords).toContain("컴포넌트");
    expect(keywords).toContain("typescript");
  });
});

describe("keywordOverlap", () => {
  it("returns 0 for no overlap", () => {
    expect(keywordOverlap(["jwt", "auth"], ["react", "css"])).toBe(0);
  });

  it("returns 1 for identical sets", () => {
    expect(keywordOverlap(["jwt", "auth"], ["jwt", "auth"])).toBe(1);
  });

  it("returns correct Jaccard score", () => {
    // intersection = 1 ("jwt"), union = 3 ("jwt", "auth", "tokens")
    expect(keywordOverlap(["jwt", "auth"], ["jwt", "tokens"])).toBeCloseTo(1 / 3, 5);
  });

  it("returns 0 for two empty arrays", () => {
    expect(keywordOverlap([], [])).toBe(0);
  });
});

describe("kMeans2", () => {
  it("handles single element", () => {
    const [g0, g1] = kMeans2([[1, 0]]);
    expect(g0).toEqual([0]);
    expect(g1).toEqual([]);
  });

  it("handles two elements", () => {
    const [g0, g1] = kMeans2([[1, 0], [0, 1]]);
    expect(g0).toHaveLength(1);
    expect(g1).toHaveLength(1);
  });

  it("splits clearly separated clusters", () => {
    const embeddings = [
      [1, 0, 0], [0.9, 0.1, 0], [0.8, 0.2, 0],
      [0, 0, 1], [0, 0.1, 0.9], [0.1, 0, 0.8],
    ];
    const [g0, g1] = kMeans2(embeddings);
    // Each group should have 3 elements
    expect(g0.length + g1.length).toBe(6);
    expect(g0.length).toBeGreaterThan(0);
    expect(g1.length).toBeGreaterThan(0);

    // Elements 0-2 should be in one group, 3-5 in the other
    const firstGroup = g0.includes(0) ? g0 : g1;
    const secondGroup = g0.includes(0) ? g1 : g0;
    expect(firstGroup).toContain(0);
    expect(firstGroup).toContain(1);
    expect(firstGroup).toContain(2);
    expect(secondGroup).toContain(3);
    expect(secondGroup).toContain(4);
    expect(secondGroup).toContain(5);
  });

  it("never returns empty groups", () => {
    // All same vector — tricky edge case
    const embeddings = [[1, 0], [1, 0], [1, 0]];
    const [g0, g1] = kMeans2(embeddings);
    expect(g0.length).toBeGreaterThan(0);
    // g1 might be empty only if total <= 1
    expect(g0.length + g1.length).toBe(3);
  });
});

describe("generateCellId", () => {
  it("generates a slug from summary text", () => {
    const id = generateCellId("JWT authentication tokens");
    expect(id).toMatch(/^jwt-authentication-tokens-[a-f0-9]{8}$/);
  });

  it("falls back to 'cell' for empty summary", () => {
    const id = generateCellId("");
    expect(id).toMatch(/^cell-[a-f0-9]{8}$/);
  });

  it("strips stop words from slug", () => {
    const id = generateCellId("Use the database for queries");
    expect(id).not.toContain("use");
    expect(id).not.toContain("the");
    expect(id).toContain("database");
  });
});

describe("getEntryText", () => {
  it("returns content for direct entries", () => {
    const entry: DirectEntry = {
      type: "direct",
      id: "1",
      project: "p",
      category: "decision",
      content: "Use REST API",
      tags: [],
      createdAt: "2026-01-01",
      embedding: [],
    };
    expect(getEntryText(entry)).toBe("Use REST API");
  });

  it("returns description for reference entries", () => {
    const entry: ReferenceEntry = {
      type: "reference",
      id: "2",
      project: "p",
      path: "/some/file.md",
      source: "claude-memory",
      description: "Notes on JWT handling",
      tags: [],
      createdAt: "2026-01-01",
      lastSynced: "2026-01-01",
      embedding: [],
    };
    expect(getEntryText(entry)).toBe("Notes on JWT handling");
  });
});
