import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  rewriteQuery,
  ruleBasedRewrite,
  classifyIntent,
} from "../src/search/query-rewriter.js";

describe("ruleBasedRewrite", () => {
  it("expands DB abbreviation to database", () => {
    const result = ruleBasedRewrite("how does the DB work");
    expect(result.expandedTerms).toContain("database");
    expect(result.rewritten).toContain("database");
  });

  it("expands API abbreviation", () => {
    const result = ruleBasedRewrite("API authentication flow");
    expect(result.expandedTerms).toContain("API interface endpoint");
  });

  it("expands PR abbreviation", () => {
    const result = ruleBasedRewrite("create a PR for this change");
    expect(result.expandedTerms).toContain("pull request");
  });

  it("expands auth abbreviation", () => {
    const result = ruleBasedRewrite("auth service design");
    expect(result.expandedTerms).toContain("authentication authorization");
  });

  it("returns original when no abbreviations match", () => {
    const result = ruleBasedRewrite("deploy the service to production");
    expect(result.expandedTerms).toHaveLength(0);
    expect(result.rewritten).toBe("deploy the service to production");
  });

  it("preserves the original query", () => {
    const result = ruleBasedRewrite("DB performance issues");
    expect(result.original).toBe("DB performance issues");
  });
});

describe("classifyIntent", () => {
  it("classifies who queries as person", () => {
    expect(classifyIntent("who reviewed this PR")).toBe("person");
  });

  it("classifies author queries as person", () => {
    expect(classifyIntent("author of the API design")).toBe("person");
  });

  it("classifies when queries as temporal", () => {
    expect(classifyIntent("when was this deployed")).toBe("temporal");
  });

  it("classifies recent queries as temporal", () => {
    expect(classifyIntent("most recent updates")).toBe("temporal");
  });

  it("classifies 'decide' as decision intent", () => {
    expect(classifyIntent("what did we decide about auth")).toBe("decision");
  });

  it("classifies decision queries as decision", () => {
    expect(classifyIntent("decided to use PostgreSQL")).toBe("decision");
  });

  it("classifies approved queries as decision", () => {
    expect(classifyIntent("approved architecture change")).toBe("decision");
  });

  it("classifies what queries as factual", () => {
    expect(classifyIntent("what is the rate limit")).toBe("factual");
  });

  it("classifies how queries as factual", () => {
    expect(classifyIntent("how does caching work")).toBe("factual");
  });

  it("defaults to exploratory for unclassified queries", () => {
    expect(classifyIntent("kubernetes deployment strategy")).toBe("exploratory");
  });
});

describe("rewriteQuery", () => {
  beforeEach(() => {
    // Ensure LLM rewrite is off
    delete process.env.CORTEX_LLM_PROVIDER;
    process.env.CORTEX_ENRICHMENT = "off";
  });

  afterEach(() => {
    delete process.env.CORTEX_ENRICHMENT;
  });

  it("falls back to rule-based when LLM is disabled", async () => {
    const result = await rewriteQuery("DB design decisions");
    expect(result.original).toBe("DB design decisions");
    expect(result.expandedTerms).toContain("database");
    expect(result.intent).toBe("decision");
  });

  it("returns correct structure", async () => {
    const result = await rewriteQuery("how does auth work");
    expect(result).toHaveProperty("original");
    expect(result).toHaveProperty("rewritten");
    expect(result).toHaveProperty("expandedTerms");
    expect(result).toHaveProperty("intent");
  });

  it("handles empty expanded terms gracefully", async () => {
    const result = await rewriteQuery("simple query");
    expect(result.expandedTerms).toHaveLength(0);
    expect(result.rewritten).toBe("simple query");
  });
});
