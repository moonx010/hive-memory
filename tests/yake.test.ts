import { describe, it, expect } from "vitest";
import { extractKeywords } from "../src/keywords/yake.js";
import { extractKeywordsFromText, reextractAllKeywords } from "../src/keywords/extractor.js";
import { randomUUID } from "node:crypto";
import { HiveDatabase } from "../src/db/database.js";
import type { Entity } from "../src/types.js";

describe("YAKE keyword extraction", () => {
  it("extracts meaningful keywords from English text", () => {
    const text = `
      We decided to use PostgreSQL instead of MongoDB for the user authentication service.
      The main reason was ACID compliance and the need for complex joins across the permissions table.
      MongoDB was considered but rejected due to the relational nature of our access control model.
    `;
    const keywords = extractKeywords(text);
    const kws = keywords.map((k) => k.keyword);

    // Should include domain-specific terms
    expect(kws.some((k) => k.includes("postgresql"))).toBe(true);
    expect(kws.some((k) => k.includes("mongodb"))).toBe(true);
    expect(kws.some((k) => k.includes("authentication") || k.includes("auth"))).toBe(true);

    // Should NOT include stopwords
    expect(kws).not.toContain("the");
    expect(kws).not.toContain("and");
    expect(kws).not.toContain("was");
    expect(kws).not.toContain("for");
  });

  it("handles Korean text", () => {
    const text = `
      우리는 인증 서비스에 PostgreSQL을 사용하기로 결정했습니다.
      주된 이유는 ACID 준수와 권한 테이블 간의 복잡한 조인이 필요했기 때문입니다.
      MongoDB도 검토했지만 관계형 접근 제어 모델의 특성상 적합하지 않았습니다.
    `;
    const keywords = extractKeywords(text);
    const kws = keywords.map((k) => k.keyword);

    expect(kws.length).toBeGreaterThan(0);
    // Should include some meaningful terms
    expect(kws.some((k) => k.includes("postgresql") || k.includes("인증") || k.includes("서비스"))).toBe(true);
  });

  it("filters out Slack user IDs and URLs", () => {
    const text = `
      <@U0APSR2N9CY> shared a link about the new API design.
      https://github.com/example/repo has the implementation details.
      The authentication middleware needs to be refactored.
    `;
    const keywords = extractKeywords(text);
    const kws = keywords.map((k) => k.keyword);

    // Should NOT include user IDs or URL fragments
    for (const kw of kws) {
      expect(kw).not.toMatch(/^u0[a-z0-9]+$/i);
      expect(kw).not.toBe("https");
      expect(kw).not.toBe("http");
    }
  });

  it("returns empty for very short text", () => {
    expect(extractKeywords("hi")).toEqual([]);
    expect(extractKeywords("")).toEqual([]);
  });

  it("returns scored keywords in ascending order (lower = more important)", () => {
    const text = "The React component uses TypeScript interfaces for type safety in the frontend application framework.";
    const keywords = extractKeywords(text);

    for (let i = 1; i < keywords.length; i++) {
      expect(keywords[i].score).toBeGreaterThanOrEqual(keywords[i - 1].score);
    }
  });

  it("extracts n-grams when meaningful", () => {
    const text = `
      The machine learning pipeline processes training data through multiple stages.
      Feature engineering is the most critical part of the machine learning workflow.
      The training data quality directly impacts model performance.
    `;
    const keywords = extractKeywords(text, { maxNgram: 3 });
    const kws = keywords.map((k) => k.keyword);

    // Should have some multi-word keywords
    const multiWord = kws.filter((k) => k.includes(" "));
    expect(multiWord.length).toBeGreaterThan(0);
  });
});

describe("extractKeywordsFromText", () => {
  it("returns plain string array", () => {
    const result = extractKeywordsFromText("The authentication service handles user login and session management.");
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result[0]).toBe("string");
  });
});

describe("reextractAllKeywords", () => {
  it("re-extracts keywords for all entities", () => {
    const db = new HiveDatabase(":memory:");
    const now = new Date().toISOString();

    // Insert entities with bad keywords (stopword-polluted)
    const e1: Entity = {
      id: randomUUID(),
      entityType: "decision",
      namespace: "local",
      content: "We decided to migrate from Express to Fastify for better TypeScript support and performance benchmarks.",
      tags: [],
      keywords: ["the", "and", "for", "was"], // bad keywords
      attributes: {},
      source: { system: "agent" },
      visibility: "team",
      domain: "code",
      confidence: "confirmed",
      createdAt: now,
      updatedAt: now,
      status: "active",
    };
    db.insertEntity(e1);

    const result = reextractAllKeywords(db);
    expect(result.processed).toBe(1);
    expect(result.updated).toBe(1);

    // Check that keywords were replaced with better ones
    const updated = db.getEntity(e1.id);
    expect(updated).not.toBeNull();
    expect(updated!.keywords).not.toContain("the");
    expect(updated!.keywords).not.toContain("and");
    expect(updated!.keywords.length).toBeGreaterThan(0);
  });

  it("filters corpus-frequent keywords", () => {
    const db = new HiveDatabase(":memory:");
    const now = new Date().toISOString();

    // Insert 5 entities that all mention "migration"
    for (let i = 0; i < 5; i++) {
      db.insertEntity({
        id: randomUUID(),
        entityType: "memory",
        namespace: "local",
        content: `Database migration strategy for service ${i}. The migration process involves schema changes and data transformation.`,
        tags: [],
        keywords: [],
        attributes: {},
        source: { system: "agent" },
        visibility: "team",
        domain: "code",
        confidence: "confirmed",
        createdAt: now,
        updatedAt: now,
        status: "active",
      });
    }

    // With maxCorpusFrequency: 0.3, "migration" appears in 100% of entities
    // so it should be filtered out
    const result = reextractAllKeywords(db, { maxCorpusFrequency: 0.3 });
    expect(result.processed).toBe(5);

    const entities = db.listEntities({ limit: 100 });
    for (const e of entities) {
      // "migration" appears in all 5 entities (100% corpus frequency > 30%)
      expect(e.keywords).not.toContain("migration");
    }
  });
});
