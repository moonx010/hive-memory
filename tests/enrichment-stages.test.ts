import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HiveDatabase } from "../src/db/database.js";
import { EnrichmentEngine } from "../src/enrichment/engine.js";
import { ClassifyProvider } from "../src/enrichment/providers/classify.js";
import type {
  Entity,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
  EnrichmentStage,
} from "../src/enrichment/types.js";
import { STAGE_ORDER, STAGE_TIMESTAMP_KEYS } from "../src/enrichment/types.js";

function createTestEntity(db: HiveDatabase, overrides: Partial<Entity> = {}): Entity {
  const id = randomUUID();
  const now = new Date().toISOString();
  const entity: Entity = {
    id,
    entityType: "memory",
    namespace: "local",
    content: "Test content that is long enough to pass the 20 char threshold",
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

function makeStageProvider(
  id: string,
  stage: EnrichmentStage,
  priority: number,
  enrichFn?: () => EnrichmentResult,
): EnrichmentProvider {
  return {
    id,
    name: id,
    applicableTo: ["*"] as ["*"],
    priority,
    stage,
    shouldEnrich: () => true,
    enrich: async () => enrichFn?.() ?? { tags: [id] },
  };
}

describe("EnrichmentEngine stage filtering", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-stage-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enrichEntity with stage='classify' only runs classify providers", async () => {
    const classifySpy = vi.fn().mockResolvedValue({ tags: ["classified"] });
    const extractSpy = vi.fn().mockResolvedValue({ tags: ["extracted"] });

    const engine = new EnrichmentEngine(db);
    engine.register({
      id: "classify",
      name: "Classify",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      stage: "classify" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: classifySpy,
    });
    engine.register({
      id: "extract",
      name: "Extract",
      applicableTo: ["*"] as ["*"],
      priority: 200,
      stage: "extract" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: extractSpy,
    });

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id, { stage: "classify" });

    expect(classifySpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it("enrichEntity with stage='extract' only runs extract providers", async () => {
    const classifySpy = vi.fn().mockResolvedValue({ tags: ["classified"] });
    const extractSpy = vi.fn().mockResolvedValue({ tags: ["extracted"] });

    const engine = new EnrichmentEngine(db);
    engine.register({
      id: "classify",
      name: "Classify",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      stage: "classify" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: classifySpy,
    });
    engine.register({
      id: "extract",
      name: "Extract",
      applicableTo: ["*"] as ["*"],
      priority: 200,
      stage: "extract" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: extractSpy,
    });

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id, { stage: "extract" });

    expect(classifySpy).not.toHaveBeenCalled();
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it("enrichEntity without stage runs all providers (backward compatible)", async () => {
    const classifySpy = vi.fn().mockResolvedValue({ tags: ["classified"] });
    const extractSpy = vi.fn().mockResolvedValue({ tags: ["extracted"] });

    const engine = new EnrichmentEngine(db);
    engine.register({
      id: "classify",
      name: "Classify",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      stage: "classify" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: classifySpy,
    });
    engine.register({
      id: "extract",
      name: "Extract",
      applicableTo: ["*"] as ["*"],
      priority: 200,
      stage: "extract" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: extractSpy,
    });

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id);

    expect(classifySpy).toHaveBeenCalledTimes(1);
    expect(extractSpy).toHaveBeenCalledTimes(1);
  });

  it("_classifiedAt is set after classify stage runs", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("classify", "classify", 100));

    const entity = createTestEntity(db, {
      content: "We decided to use PostgreSQL for the new project database",
    });

    await engine.enrichEntity(entity.id, { stage: "classify" });

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._classifiedAt).toBeDefined();
    expect(updated.attributes._extractedAt).toBeUndefined();
  });

  it("_extractedAt is set after extract stage runs", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("extractor", "extract", 200));

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id, { stage: "extract" });

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._extractedAt).toBeDefined();
    expect(updated.attributes._classifiedAt).toBeUndefined();
  });

  it("all stage timestamps set when no stage filter", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("classify", "classify", 100));
    engine.register(makeStageProvider("extractor", "extract", 200));

    const entity = createTestEntity(db);
    await engine.enrichEntity(entity.id);

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._classifiedAt).toBeDefined();
    expect(updated.attributes._extractedAt).toBeDefined();
  });
});

describe("EnrichmentEngine enrichBatch with stage", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-batch-stage-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enrichBatch with stage='classify' processes entities through classify only", async () => {
    const classifySpy = vi.fn().mockResolvedValue({ tags: ["classified"] });
    const extractSpy = vi.fn().mockResolvedValue({ tags: ["extracted"] });

    const engine = new EnrichmentEngine(db);
    engine.register({
      id: "classify",
      name: "Classify",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      stage: "classify" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: classifySpy,
    });
    engine.register({
      id: "extract",
      name: "Extract",
      applicableTo: ["*"] as ["*"],
      priority: 200,
      stage: "extract" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: extractSpy,
    });

    createTestEntity(db);
    createTestEntity(db);

    const result = await engine.enrichBatch({ stage: "classify" });

    expect(result.processed).toBe(2);
    expect(result.enriched).toBe(2);
    expect(classifySpy).toHaveBeenCalledTimes(2);
    expect(extractSpy).not.toHaveBeenCalled();
  });

  it("entities have _classifiedAt but not _extractedAt after classify-only batch", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("classify", "classify", 100));
    engine.register(makeStageProvider("extractor", "extract", 200));

    const e1 = createTestEntity(db);
    const e2 = createTestEntity(db);

    await engine.enrichBatch({ stage: "classify" });

    const u1 = db.getEntity(e1.id)!;
    const u2 = db.getEntity(e2.id)!;

    expect(u1.attributes._classifiedAt).toBeDefined();
    expect(u1.attributes._extractedAt).toBeUndefined();
    expect(u2.attributes._classifiedAt).toBeDefined();
    expect(u2.attributes._extractedAt).toBeUndefined();
  });

  it("subsequent enrichBatch with stage='extract' runs extract on same entities", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("classify", "classify", 100));
    engine.register(makeStageProvider("extractor", "extract", 200));

    const entity = createTestEntity(db);

    await engine.enrichBatch({ stage: "classify" });
    await engine.enrichBatch({ stage: "extract" });

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._classifiedAt).toBeDefined();
    expect(updated.attributes._extractedAt).toBeDefined();
  });

  it("backward compatibility: enrichBatch without stage runs all providers", async () => {
    const engine = new EnrichmentEngine(db);
    engine.register(makeStageProvider("classify", "classify", 100));
    engine.register(makeStageProvider("extractor", "extract", 200));

    const entity = createTestEntity(db);
    await engine.enrichBatch();

    const updated = db.getEntity(entity.id)!;
    expect(updated.attributes._classifiedAt).toBeDefined();
    expect(updated.attributes._extractedAt).toBeDefined();
  });

  it("STAGE_ORDER defines correct ordering", () => {
    expect(STAGE_ORDER).toEqual(["classify", "extract", "stitch", "resolve"]);
  });

  it("STAGE_TIMESTAMP_KEYS has entries for all stages", () => {
    for (const stage of STAGE_ORDER) {
      expect(STAGE_TIMESTAMP_KEYS[stage]).toBeDefined();
      expect(STAGE_TIMESTAMP_KEYS[stage]).toMatch(/^_/);
    }
  });
});

describe("ClassifyProvider stage annotation", () => {
  it("has stage = 'classify'", () => {
    const provider = new ClassifyProvider();
    expect(provider.stage).toBe("classify");
  });
});

describe("EnrichmentEngine resume-from", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hive-resume-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enrichBatch with resumeFrom skips entities that already completed prior stages", async () => {
    const classifySpy = vi.fn().mockResolvedValue({ tags: ["classified"] });
    const engine = new EnrichmentEngine(db);
    engine.register({
      id: "classify",
      name: "Classify",
      applicableTo: ["*"] as ["*"],
      priority: 100,
      stage: "classify" as EnrichmentStage,
      shouldEnrich: () => true,
      enrich: classifySpy,
    });

    // One entity already classified (has _classifiedAt)
    const alreadyClassified = createTestEntity(db);
    db.updateEntityAttributes(alreadyClassified.id, {
      _classifiedAt: new Date().toISOString(),
    });

    // One entity not yet classified
    createTestEntity(db);

    // resumeFrom: "extract" means skip entities that already completed stages before "extract"
    // (stages before "extract" = ["classify"])
    await engine.enrichBatch({ resumeFrom: "extract" });

    // The already-classified entity should be skipped (it has _classifiedAt)
    // The other entity should be processed
    expect(classifySpy).toHaveBeenCalledTimes(1);
  });
});
