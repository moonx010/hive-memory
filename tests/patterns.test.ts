import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HiveDatabase } from "../src/db/database.js";
import { PatternAnalyzer } from "../src/advisor/patterns.js";
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

/** Create an ISO timestamp for a specific hour offset from now. */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

/** Create an ISO timestamp N days ago. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}

describe("PatternAnalyzer", () => {
  let db: HiveDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "patterns-test-"));
    db = new HiveDatabase(join(tmpDir, "test.db"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("analyze — empty database", () => {
    it("returns zero distributions on empty database", () => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze();

      expect(report.period.from).toBeTruthy();
      expect(report.period.to).toBeTruthy();
      expect(report.activity.topProjects).toHaveLength(0);
      expect(report.activity.domainDistribution).toEqual({});
      expect(report.activity.typeDistribution).toEqual({});
      expect(report.collaboration.edges).toHaveLength(0);
      expect(report.collaboration.hubs).toHaveLength(0);
    });
  });

  describe("hourly distribution", () => {
    it("buckets entities by creation hour", () => {
      const ts = new Date("2025-01-01T14:30:00.000Z").toISOString(); // hour 14
      makeEntity(db, {
        id: "e1",
        entityType: "memory",
        content: "test",
        createdAt: ts,
        updatedAt: ts,
      });
      makeEntity(db, {
        id: "e2",
        entityType: "memory",
        content: "test2",
        createdAt: ts,
        updatedAt: ts,
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: "2025-01-01T00:00:00.000Z" });

      expect(report.activity.hourlyDistribution[14]).toBeGreaterThanOrEqual(2);
    });

    it("initializes all 24 hours in distribution", () => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze();
      expect(Object.keys(report.activity.hourlyDistribution)).toHaveLength(24);
      for (let h = 0; h < 24; h++) {
        expect(report.activity.hourlyDistribution[h]).toBeDefined();
      }
    });
  });

  describe("daily distribution", () => {
    it("buckets entities by day of week", () => {
      // Wednesday = day 3, Jan 1 2025 is a Wednesday
      const wednesdayTs = new Date("2025-01-01T10:00:00.000Z").toISOString();
      makeEntity(db, {
        id: "e-wed",
        entityType: "memory",
        content: "wednesday entity",
        createdAt: wednesdayTs,
        updatedAt: wednesdayTs,
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: "2025-01-01T00:00:00.000Z" });

      const dayOfWeek = new Date(wednesdayTs).getUTCDay();
      expect(report.activity.dailyDistribution[dayOfWeek]).toBeGreaterThanOrEqual(1);
    });

    it("initializes all 7 days in distribution", () => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze();
      expect(Object.keys(report.activity.dailyDistribution)).toHaveLength(7);
      for (let d = 0; d < 7; d++) {
        expect(report.activity.dailyDistribution[d]).toBeDefined();
      }
    });
  });

  describe("top projects", () => {
    it("counts entities per project and returns top-N sorted", () => {
      // proj-a: 3 entities, proj-b: 1 entity
      for (let i = 0; i < 3; i++) {
        makeEntity(db, {
          id: `proj-a-e${i}`,
          entityType: "memory",
          content: `proj-a entry ${i}`,
          project: "proj-a",
          createdAt: hoursAgo(1),
          updatedAt: hoursAgo(1),
        });
      }
      makeEntity(db, {
        id: "proj-b-e0",
        entityType: "memory",
        content: "proj-b entry",
        project: "proj-b",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      expect(report.activity.topProjects[0].project).toBe("proj-a");
      expect(report.activity.topProjects[0].count).toBe(3);
      expect(report.activity.topProjects[1].project).toBe("proj-b");
      expect(report.activity.topProjects[1].count).toBe(1);
    });

    it("filters by project when opts.project is set", () => {
      makeEntity(db, {
        id: "pa1",
        entityType: "memory",
        content: "only project A",
        project: "proj-a",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
      makeEntity(db, {
        id: "pb1",
        entityType: "memory",
        content: "only project B",
        project: "proj-b",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7), project: "proj-a" });

      expect(report.activity.topProjects).toHaveLength(1);
      expect(report.activity.topProjects[0].project).toBe("proj-a");
    });
  });

  describe("domain distribution", () => {
    it("counts entities per domain", () => {
      makeEntity(db, {
        id: "d1",
        entityType: "memory",
        content: "code entity",
        domain: "code",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
      makeEntity(db, {
        id: "d2",
        entityType: "memory",
        content: "meetings entity",
        domain: "meetings",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
      makeEntity(db, {
        id: "d3",
        entityType: "memory",
        content: "meetings entity 2",
        domain: "meetings",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      expect(report.activity.domainDistribution["code"]).toBe(1);
      expect(report.activity.domainDistribution["meetings"]).toBe(2);
    });
  });

  describe("entity type distribution", () => {
    it("counts entities per entityType", () => {
      makeEntity(db, {
        id: "t1",
        entityType: "memory",
        content: "memory 1",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
      makeEntity(db, {
        id: "t2",
        entityType: "memory",
        content: "memory 2",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
      makeEntity(db, {
        id: "t3",
        entityType: "decision",
        content: "decision 1",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      expect(report.activity.typeDistribution["memory"]).toBe(2);
      expect(report.activity.typeDistribution["decision"]).toBe(1);
    });
  });

  describe("collaboration graph", () => {
    function makePerson(id: string, name: string): Entity {
      return makeEntity(db, {
        id,
        entityType: "person",
        content: name,
        title: name,
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
    }

    function makeMeeting(id: string): Entity {
      return makeEntity(db, {
        id,
        entityType: "meeting",
        content: `Meeting ${id}`,
        title: `Meeting ${id}`,
        domain: "meetings",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });
    }

    function linkAttended(personId: string, meetingId: string): void {
      db.insertSynapse({
        id: `syn-${personId}-${meetingId}`,
        source: personId,
        target: meetingId,
        axon: "attended",
        weight: 1.0,
        metadata: {},
        formedAt: new Date().toISOString(),
        lastPotentiated: new Date().toISOString(),
      });
    }

    it("creates edges for person pairs who share 2+ meetings", () => {
      makePerson("alice", "Alice");
      makePerson("bob", "Bob");
      const m1 = makeMeeting("meeting-1");
      const m2 = makeMeeting("meeting-2");

      linkAttended("alice", m1.id);
      linkAttended("bob", m1.id);
      linkAttended("alice", m2.id);
      linkAttended("bob", m2.id);

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      expect(report.collaboration.edges).toHaveLength(1);
      const edge = report.collaboration.edges[0];
      expect([edge.personA, edge.personB]).toContain("Alice");
      expect([edge.personA, edge.personB]).toContain("Bob");
      expect(edge.sharedMeetings).toBe(2);
    });

    it("excludes pairs who share only 1 meeting", () => {
      makePerson("carol", "Carol");
      makePerson("dave", "Dave");
      const m1 = makeMeeting("meeting-x");

      linkAttended("carol", m1.id);
      linkAttended("dave", m1.id);

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      // Only 1 shared meeting — should not appear as edge
      const carolDaveEdge = report.collaboration.edges.find(
        (e) =>
          (e.personA === "Carol" && e.personB === "Dave") ||
          (e.personA === "Dave" && e.personB === "Carol"),
      );
      expect(carolDaveEdge).toBeUndefined();
    });

    it("computes hubs sorted by connection count", () => {
      // Alice collaborates with Bob and Carol; Bob only with Alice
      makePerson("hub-alice", "HubAlice");
      makePerson("hub-bob", "HubBob");
      makePerson("hub-carol", "HubCarol");

      const m1 = makeMeeting("hub-m1");
      const m2 = makeMeeting("hub-m2");
      const m3 = makeMeeting("hub-m3");
      const m4 = makeMeeting("hub-m4");

      // Alice + Bob: meetings m1, m2
      linkAttended("hub-alice", m1.id);
      linkAttended("hub-bob", m1.id);
      linkAttended("hub-alice", m2.id);
      linkAttended("hub-bob", m2.id);

      // Alice + Carol: meetings m3, m4
      linkAttended("hub-alice", m3.id);
      linkAttended("hub-carol", m3.id);
      linkAttended("hub-alice", m4.id);
      linkAttended("hub-carol", m4.id);

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      // Alice should be the hub with 2 connections
      const alice = report.collaboration.hubs.find((h) => h.name === "HubAlice");
      expect(alice).toBeDefined();
      expect(alice!.connections).toBe(2);

      // Alice is the top hub
      expect(report.collaboration.hubs[0].name).toBe("HubAlice");
    });
  });

  describe("markdownOutput", () => {
    it("includes the period header", () => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze();
      expect(report.markdownOutput).toContain("# Working Pattern Analysis");
      expect(report.markdownOutput).toContain("**Period:**");
    });

    it("includes hourly heatmap section", () => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze();
      expect(report.markdownOutput).toContain("## Activity Heatmap");
    });

    it("includes top projects when present", () => {
      makeEntity(db, {
        id: "md-e1",
        entityType: "memory",
        content: "content",
        project: "my-project",
        createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1),
      });

      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({ since: daysAgo(7) });

      expect(report.markdownOutput).toContain("## Most Active Projects");
      expect(report.markdownOutput).toContain("my-project");
    });
  });
});
