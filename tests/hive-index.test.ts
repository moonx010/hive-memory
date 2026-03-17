import { describe, it, expect } from "vitest";
import {
  extractKeywords,
  keywordOverlap,
  keywordSplit2,
  generateCellId,
  getEntryText,
} from "../src/store/hive-index.js";
import type { DirectEntry, ReferenceEntry } from "../src/types.js";

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

describe("keywordSplit2", () => {
  it("handles single element", () => {
    const entry: DirectEntry = {
      type: "direct",
      id: "1",
      project: "p",
      category: "note",
      content: "Hello world test",
      tags: [],
      createdAt: "2026-01-01",
    };
    const [g0, g1] = keywordSplit2([entry]);
    expect(g0).toEqual([0]);
    expect(g1).toEqual([]);
  });

  it("handles two elements", () => {
    const entries: DirectEntry[] = [
      {
        type: "direct", id: "1", project: "p", category: "note",
        content: "JWT authentication tokens", tags: [], createdAt: "2026-01-01",
      },
      {
        type: "direct", id: "2", project: "p", category: "note",
        content: "React component design", tags: [], createdAt: "2026-01-01",
      },
    ];
    const [g0, g1] = keywordSplit2(entries);
    expect(g0).toHaveLength(1);
    expect(g1).toHaveLength(1);
  });

  it("splits clearly separated clusters by keywords", () => {
    const entries: DirectEntry[] = [
      { type: "direct", id: "0", project: "p", category: "note", content: "JWT authentication tokens for API", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "1", project: "p", category: "note", content: "JWT token expiration handling", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "2", project: "p", category: "note", content: "JWT auth middleware setup", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "3", project: "p", category: "note", content: "React component lifecycle hooks", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "4", project: "p", category: "note", content: "React state management patterns", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "5", project: "p", category: "note", content: "React rendering optimization tips", tags: [], createdAt: "2026-01-01" },
    ];
    const [g0, g1] = keywordSplit2(entries);
    // Each group should have entries
    expect(g0.length + g1.length).toBe(6);
    expect(g0.length).toBeGreaterThan(0);
    expect(g1.length).toBeGreaterThan(0);
  });

  it("never returns empty first group", () => {
    // All same content — should still produce non-empty groups
    const entries: DirectEntry[] = [
      { type: "direct", id: "0", project: "p", category: "note", content: "hello world test", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "1", project: "p", category: "note", content: "hello world test", tags: [], createdAt: "2026-01-01" },
      { type: "direct", id: "2", project: "p", category: "note", content: "hello world test", tags: [], createdAt: "2026-01-01" },
    ];
    const [g0, g1] = keywordSplit2(entries);
    expect(g0.length).toBeGreaterThan(0);
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
    };
    expect(getEntryText(entry)).toBe("Notes on JWT handling");
  });
});
