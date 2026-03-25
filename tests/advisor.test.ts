import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HiveDatabase } from "../src/db/database.js";
import { WorkflowAdvisor } from "../src/advisor/index.js";
import type { Entity } from "../src/types.js";

function makeEntity(
  db: HiveDatabase,
  overrides: Partial<Entity> & { id: string; entityType: Entity["entityType"]; content: string },
): Entity {
  const now = new Date().toISOString();
  const entity: Entity = {
    namespace: "local",
    tags: [],
    keywords: [],
    attributes: {},
    source: { system: "test" },
    visibility: "personal",
    domain: "meetings",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
  db.insertEntity(entity);
  return entity;
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("WorkflowAdvisor", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "advisor-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("stale action detection", () => {
    it("detects warning for actions open > 7 days", () => {
      makeEntity(db, {
        id: "task-1",
        entityType: "task",
        content: "Implement feature X",
        title: "Implement feature X",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(10),
        updatedAt: daysAgo(10),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      const staleInsights = report.insights.filter((i) => i.type === "stale-action");
      expect(staleInsights).toHaveLength(1);
      expect(staleInsights[0].severity).toBe("warning");
      expect(staleInsights[0].entities).toContain("task-1");
    });

    it("detects critical for actions open > 30 days", () => {
      makeEntity(db, {
        id: "task-old",
        entityType: "task",
        content: "Fix the database issue",
        title: "Fix the database issue",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(35),
        updatedAt: daysAgo(35),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      const criticalInsights = report.insights.filter(
        (i) => i.type === "stale-action" && i.severity === "critical",
      );
      expect(criticalInsights).toHaveLength(1);
      expect(criticalInsights[0].entities).toContain("task-old");
    });

    it("ignores actions that are not open", () => {
      makeEntity(db, {
        id: "task-done",
        entityType: "task",
        content: "Completed task",
        attributes: { actionStatus: "done" },
        createdAt: daysAgo(20),
        updatedAt: daysAgo(20),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      const staleInsights = report.insights.filter((i) => i.type === "stale-action");
      expect(staleInsights).toHaveLength(0);
    });

    it("ignores actions open for < 7 days", () => {
      makeEntity(db, {
        id: "task-recent",
        entityType: "task",
        content: "New task",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(3),
        updatedAt: daysAgo(3),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      const staleInsights = report.insights.filter((i) => i.type === "stale-action");
      expect(staleInsights).toHaveLength(0);
    });
  });

  describe("stats computation", () => {
    it("computes totalDecisions correctly", () => {
      makeEntity(db, { id: "d1", entityType: "decision", content: "Use PostgreSQL" });
      makeEntity(db, { id: "d2", entityType: "decision", content: "Use Redis for caching" });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.stats.totalDecisions).toBe(2);
    });

    it("computes openActions and totalActions correctly", () => {
      makeEntity(db, {
        id: "t1",
        entityType: "task",
        content: "Task 1",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(1),
        updatedAt: daysAgo(1),
      });
      makeEntity(db, {
        id: "t2",
        entityType: "task",
        content: "Task 2",
        attributes: { actionStatus: "done" },
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.stats.totalActions).toBe(2);
      expect(report.stats.openActions).toBe(1);
    });

    it("computes overdueActions for tasks > 7 days old", () => {
      makeEntity(db, {
        id: "t-overdue",
        entityType: "task",
        content: "Overdue task",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(10),
        updatedAt: daysAgo(10),
      });
      makeEntity(db, {
        id: "t-fresh",
        entityType: "task",
        content: "Fresh task",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(2),
        updatedAt: daysAgo(2),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.stats.overdueActions).toBe(1);
    });

    it("includes topCollaborators based on meeting attendance", () => {
      const alice = makeEntity(db, {
        id: "person-alice",
        entityType: "person",
        content: "Alice",
        title: "Alice",
        domain: "meetings" as Entity["domain"],
      });
      const meeting = makeEntity(db, {
        id: "meeting-1",
        entityType: "meeting",
        content: "Weekly sync",
        domain: "meetings" as Entity["domain"],
      });

      // Create attended synapse
      db.upsertSynapse({
        sourceId: alice.id,
        targetId: meeting.id,
        axon: "attended",
        weight: 1.0,
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.stats.topCollaborators.length).toBeGreaterThan(0);
      expect(report.stats.topCollaborators[0].name).toBe("Alice");
      expect(report.stats.topCollaborators[0].interactions).toBe(1);
    });

    it("returns empty report for empty database", () => {
      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.insights).toHaveLength(0);
      expect(report.stats.totalDecisions).toBe(0);
      expect(report.stats.totalActions).toBe(0);
      expect(report.stats.topCollaborators).toHaveLength(0);
      expect(report.markdownOutput).toContain("Workflow Advisor Report");
    });
  });

  describe("repeated topic detection", () => {
    it("detects repeated topics when 3+ entities share similar keywords from different dates", () => {
      const keywords = ["authentication", "jwt", "tokens"];
      makeEntity(db, {
        id: "e1",
        entityType: "memory",
        content: "Discussion about auth",
        keywords,
        createdAt: daysAgo(20),
        updatedAt: daysAgo(20),
      });
      makeEntity(db, {
        id: "e2",
        entityType: "memory",
        content: "More auth discussion",
        keywords,
        createdAt: daysAgo(10),
        updatedAt: daysAgo(10),
      });
      makeEntity(db, {
        id: "e3",
        entityType: "memory",
        content: "Auth again",
        keywords,
        createdAt: daysAgo(5),
        updatedAt: daysAgo(5),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      const repeatedInsights = report.insights.filter((i) => i.type === "repeated-topic");
      expect(repeatedInsights.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("markdown output", () => {
    it("includes stats table in markdown", () => {
      makeEntity(db, { id: "d1", entityType: "decision", content: "Use TypeScript" });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.markdownOutput).toContain("# Workflow Advisor Report");
      expect(report.markdownOutput).toContain("Total decisions");
      expect(report.markdownOutput).toContain("1");
    });

    it("includes critical issues section when critical insights exist", () => {
      makeEntity(db, {
        id: "task-critical",
        entityType: "task",
        content: "Very old task",
        attributes: { actionStatus: "open" },
        createdAt: daysAgo(35),
        updatedAt: daysAgo(35),
      });

      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();

      expect(report.markdownOutput).toContain("Critical Issues");
    });
  });
});
