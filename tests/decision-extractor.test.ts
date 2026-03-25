import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { HiveDatabase } from "../src/db/database.js";
import { EnrichmentEngine } from "../src/enrichment/engine.js";
import {
  DecisionExtractorProvider,
  DECISION_SIGNALS,
  ACTION_SIGNALS,
} from "../src/enrichment/providers/decision-extractor.js";
import type {
  Entity,
  EnrichmentContext,
} from "../src/enrichment/types.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createTestEntity(
  db: HiveDatabase,
  overrides: Partial<Entity> = {},
): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  const entity: Entity = {
    id,
    entityType: "message",
    namespace: "local",
    content: "Default test content that is long enough for the provider",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "test" },
    visibility: "personal",
    domain: "code",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
  db.insertEntity(entity);
  return entity;
}

describe("DecisionExtractorProvider", () => {
  const provider = new DecisionExtractorProvider();

  describe("shouldEnrich", () => {
    it("returns false for entity with _decisionsExtracted", () => {
      const entity = {
        content: "We decided to use PostgreSQL for the new project database service",
        attributes: { _decisionsExtracted: true },
      } as unknown as Entity;
      expect(provider.shouldEnrich(entity)).toBe(false);
    });

    it("returns false for short content", () => {
      const entity = {
        content: "decided to use Redis",
        attributes: {},
      } as unknown as Entity;
      expect(provider.shouldEnrich(entity)).toBe(false);
    });

    it("returns true for content with decision signal", () => {
      const entity = {
        content: "After reviewing all options, we decided to use PostgreSQL for the new project database service",
        attributes: {},
      } as unknown as Entity;
      expect(provider.shouldEnrich(entity)).toBe(true);
    });

    it("returns true for content with action signal", () => {
      const entity = {
        content: "Action item: @alice will set up the CI pipeline by Friday for the team to use",
        attributes: {},
      } as unknown as Entity;
      expect(provider.shouldEnrich(entity)).toBe(true);
    });

    it("returns false for content with no signals", () => {
      const entity = {
        content: "The weather today is really nice. I went for a walk in the park and had a good time.",
        attributes: {},
      } as unknown as Entity;
      expect(provider.shouldEnrich(entity)).toBe(false);
    });
  });

  describe("extractWithRules", () => {
    it("extracts decision from content with 'decided to'", () => {
      const result = provider.extractWithRules(
        "We decided to use Redis for caching\nBecause it's fast",
      );
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].summary).toContain("decided to use Redis");
      expect(result.decisions[0].confidence).toBe("implicit");
    });

    it("extracts action with @owner", () => {
      const result = provider.extractWithRules(
        "Action item: @bob will deploy the service by Friday",
      );
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0].owner).toBe("@bob");
      expect(result.actions[0].status).toBe("open");
    });

    it("extracts checkbox action items", () => {
      const result = provider.extractWithRules(
        "Tasks:\n[ ] Set up database\n[ ] Write migration",
      );
      expect(result.actions).toHaveLength(2);
    });

    it("extracts both decisions and actions from mixed content", () => {
      const result = provider.extractWithRules(
        "We agreed to use TypeScript\nAction item: @alice will set up the project\n[ ] Review the architecture",
      );
      expect(result.decisions).toHaveLength(1);
      expect(result.actions).toHaveLength(2);
    });

    it("returns empty for neutral content", () => {
      const result = provider.extractWithRules(
        "The meeting was productive.\nWe discussed various topics.\nEveryone participated.",
      );
      expect(result.decisions).toHaveLength(0);
      expect(result.actions).toHaveLength(0);
    });
  });

  describe("enrich (rule-based, no LLM)", () => {
    let db: HiveDatabase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hive-dae-test-"));
      db = new HiveDatabase(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("produces decision and task derived entities", async () => {
      const entity = createTestEntity(db, {
        entityType: "conversation",
        content:
          "We decided to use PostgreSQL for the database.\nAction item: @bob will set up the database schema by Friday.",
      });

      const ctx: EnrichmentContext = {
        db,
        findRelated: () => [],
      };

      const result = await provider.enrich(entity, ctx);

      expect(result.attributes?._decisionsExtracted).toBe(true);
      expect(result.derivedEntities).toHaveLength(2);

      const decisionDraft = result.derivedEntities!.find(
        (d) => d.entityType === "decision",
      );
      expect(decisionDraft).toBeDefined();
      expect(decisionDraft!.tags).toContain("decision");
      expect(decisionDraft!.tags).toContain("extracted");
      expect(decisionDraft!.source.externalId).toMatch(/^ce:decision:/);

      const taskDraft = result.derivedEntities!.find(
        (d) => d.entityType === "task",
      );
      expect(taskDraft).toBeDefined();
      expect(taskDraft!.tags).toContain("action-item");
      expect(taskDraft!.attributes.owner).toBe("@bob");
      expect(taskDraft!.source.externalId).toMatch(/^ce:action:/);
    });

    it("creates derived synapses", async () => {
      const entity = createTestEntity(db, {
        entityType: "message",
        content:
          "We decided to use TypeScript for the entire project codebase going forward.",
      });

      const ctx: EnrichmentContext = {
        db,
        findRelated: () => [],
      };

      const result = await provider.enrich(entity, ctx);
      expect(result.synapses).toHaveLength(1);
      expect(result.synapses![0].axon).toBe("derived");
      expect(result.synapses![0].weight).toBe(1.0);
    });

    it("stamps _decisionsExtracted even when no decisions found", async () => {
      // Content with signals but after rule extraction produces empty results
      // This tests the case where signals fire but rules don't extract
      const entity = createTestEntity(db, {
        entityType: "message",
        content:
          "We decided to postpone everything until next quarter.\nNo action items needed at this time.",
      });

      const ctx: EnrichmentContext = {
        db,
        findRelated: () => [],
      };

      const result = await provider.enrich(entity, ctx);
      expect(result.attributes?._decisionsExtracted).toBe(true);
    });
  });

  describe("integration with EnrichmentEngine", () => {
    let db: HiveDatabase;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "hive-dae-int-test-"));
      db = new HiveDatabase(join(tmpDir, "test.db"));
    });

    afterEach(() => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("creates derived entities in DB and is idempotent", async () => {
      const engine = new EnrichmentEngine(db);
      engine.register(new DecisionExtractorProvider());

      const entity = createTestEntity(db, {
        entityType: "conversation",
        content:
          "We decided to use PostgreSQL for the database.\nAction item: @alice will create the schema by Friday.",
      });

      // First run
      await engine.enrichEntity(entity.id);

      // Check derived entities exist
      const decisions = db.listEntities({ entityType: "decision" });
      expect(decisions.length).toBeGreaterThanOrEqual(1);

      const tasks = db.listEntities({ entityType: "task" });
      expect(tasks.length).toBeGreaterThanOrEqual(1);

      // Check source entity is stamped
      const updated = db.getEntity(entity.id)!;
      expect(updated.attributes._decisionsExtracted).toBe(true);

      // Second run — should be a no-op
      const decisionCountBefore = db.listEntities({ entityType: "decision" }).length;
      await engine.enrichEntity(entity.id);
      const decisionCountAfter = db.listEntities({ entityType: "decision" }).length;
      expect(decisionCountAfter).toBe(decisionCountBefore);
    });

    it("creates derived synapses between source and extracted entities", async () => {
      const engine = new EnrichmentEngine(db);
      engine.register(new DecisionExtractorProvider());

      const entity = createTestEntity(db, {
        entityType: "meeting",
        content:
          "Consensus: we will migrate to Kubernetes for all production workloads by Q3.",
      });

      await engine.enrichEntity(entity.id);

      const synapses = db.getSynapsesByEntry(entity.id, "outgoing", "derived");
      expect(synapses.length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("Signal patterns", () => {
  it("DECISION_SIGNALS has at least 10 patterns", () => {
    expect(DECISION_SIGNALS.length).toBeGreaterThanOrEqual(10);
  });

  it("ACTION_SIGNALS has at least 8 patterns", () => {
    expect(ACTION_SIGNALS.length).toBeGreaterThanOrEqual(8);
  });
});
