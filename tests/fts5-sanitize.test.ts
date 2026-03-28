import { describe, it, expect } from "vitest";
import { sanitizeFTS5Query } from "../src/db/entity-ops.js";

describe("sanitizeFTS5Query", () => {
  it("passes through normal queries", () => {
    expect(sanitizeFTS5Query("hello world")).toBe("hello world");
  });

  it("removes asterisks and column filters", () => {
    // "content:*" → column filter removed → "*" → asterisk removed → empty → fallback
    expect(sanitizeFTS5Query("content:*")).toBe('""');
    // With actual content after the column filter
    expect(sanitizeFTS5Query("title:hello world")).toBe("hello world");
  });

  it("removes column filters", () => {
    expect(sanitizeFTS5Query("title:hello")).toBe("hello");
  });

  it("balances unmatched quotes by removing all", () => {
    expect(sanitizeFTS5Query('"unbalanced')).toBe("unbalanced");
  });

  it("preserves balanced quotes", () => {
    expect(sanitizeFTS5Query('"balanced query"')).toBe('"balanced query"');
  });

  it("removes parentheses", () => {
    expect(sanitizeFTS5Query("(a OR b)")).toBe("a OR b");
  });

  it("handles injection attempt", () => {
    const result = sanitizeFTS5Query('") OR 1=1 --');
    expect(result).not.toContain('"');
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns safe fallback for empty-after-sanitize", () => {
    expect(sanitizeFTS5Query("***")).toBe('""');
  });

  it("removes NEAR operator", () => {
    // NEAR(a b) → removed → empty → fallback
    expect(sanitizeFTS5Query("NEAR(a b)")).toBe('""');
    expect(sanitizeFTS5Query("hello NEAR(a b) world")).toBe("hello world");
  });

  it("collapses excessive whitespace", () => {
    expect(sanitizeFTS5Query("  hello   world  ")).toBe("hello world");
  });
});
