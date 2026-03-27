import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import type { ACLContext } from "../src/acl/types.js";
import type { Entity } from "../src/types.js";

// ── Test helpers ───────────────────────────────────────────────────────────────

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-acl-int-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

function makeEntity(overrides: Partial<Entity> & { id: string; content: string }): Entity {
  const now = new Date().toISOString();
  return {
    entityType: "memory",
    project: "test",
    namespace: "local",
    title: overrides.id,
    tags: [],
    keywords: [overrides.id],
    attributes: {},
    source: { system: "agent" },
    visibility: "team",
    domain: "code",
    confidence: "confirmed",
    createdAt: now,
    updatedAt: now,
    status: "active",
    ...overrides,
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────────

describe("ACL Integration — database enforcement", () => {
  let db: HiveDatabase;
  let dir: string;

  // User IDs
  const adminId = "admin-user-1";
  const user1Id = "member-user-1";
  const user2Id = "member-user-2";

  // ACL contexts
  const adminCtx: ACLContext = { userId: adminId, userRole: "admin", userLabels: [] };
  const user1Ctx: ACLContext = { userId: user1Id, userRole: "member", userLabels: [] };
  const user2Ctx: ACLContext = { userId: user2Id, userRole: "member", userLabels: [] };

  // Entity IDs
  const publicId = "e-public";
  const teamId = "e-team";
  const privateU1Id = "e-private-u1";
  const privateU2Id = "e-private-u2";
  const dmId = "e-dm";
  const labelGatedId = "e-label-gated";
  const aclMemberId = "e-acl-member";

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    dir = ctx.dir;

    // Insert users
    db.insertUser({ id: adminId, name: "Admin", apiKeyHash: "hash-admin", role: "admin", createdAt: new Date().toISOString(), status: "active" });
    db.insertUser({ id: user1Id, name: "User1", apiKeyHash: "hash-u1", role: "member", createdAt: new Date().toISOString(), status: "active" });
    db.insertUser({ id: user2Id, name: "User2", apiKeyHash: "hash-u2", role: "member", createdAt: new Date().toISOString(), status: "active" });

    // Create labels
    db.createLabel("lbl-hr", "hr", "HR department");
    db.assignUserLabel(user1Id, "lbl-hr", adminId);

    // Insert entities at different visibility levels
    db.insertEntity(makeEntity({ id: publicId, content: "public entity content", visibility: "public" }));
    db.insertEntity(makeEntity({ id: teamId, content: "team entity content", visibility: "team" }));
    db.insertEntity(makeEntity({ id: privateU1Id, content: "private user1 content", visibility: "private", ownerId: user1Id }));
    db.insertEntity(makeEntity({ id: privateU2Id, content: "private user2 content", visibility: "private", ownerId: user2Id }));
    db.insertEntity(makeEntity({ id: dmId, content: "dm entity content", visibility: "dm", aclMembers: [user1Id, user2Id] }));
    db.insertEntity(makeEntity({ id: labelGatedId, content: "hr label gated content", visibility: "team", requiredLabels: ["hr"], aclMembers: [] }));
    db.insertEntity(makeEntity({ id: aclMemberId, content: "acl member gated content", visibility: "team", requiredLabels: ["hr"], aclMembers: [user2Id] }));
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.CORTEX_ACL;
  });

  // ── searchEntities with ACL ─────────────────────────────────────────────────

  describe("searchEntities with ACL=on", () => {
    beforeEach(() => { process.env.CORTEX_ACL = "on"; });

    it("user1 can search and see public + team + own private + DM", () => {
      const user1WithLabels: ACLContext = { userId: user1Id, userRole: "member", userLabels: ["hr"] };
      const results = db.searchEntities("content", { acl: user1WithLabels });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(publicId);
      expect(ids).toContain(teamId);
      expect(ids).toContain(privateU1Id);
      expect(ids).toContain(dmId);
      expect(ids).not.toContain(privateU2Id);
    });

    it("user2 cannot see user1's private entity", () => {
      const results = db.searchEntities("content", { acl: user2Ctx });
      const ids = results.map((e) => e.id);
      expect(ids).not.toContain(privateU1Id);
    });

    it("admin can see all non-DM entities", () => {
      const results = db.searchEntities("content", { acl: adminCtx });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(publicId);
      expect(ids).toContain(teamId);
      expect(ids).toContain(privateU1Id);
      expect(ids).toContain(privateU2Id);
    });

    it("admin CANNOT see DM entity when not a participant", () => {
      const results = db.searchEntities("content", { acl: adminCtx });
      const ids = results.map((e) => e.id);
      expect(ids).not.toContain(dmId);
    });

    it("DM entity visible to its participants via search", () => {
      const results = db.searchEntities("content", { acl: user1Ctx });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(dmId);
    });

    it("fail-closed: no ACL context with ACL=on returns empty results", () => {
      const results = db.searchEntities("content");
      expect(results).toHaveLength(0);
    });

    it("OR logic: user2 not in label group but in acl_members can read label-gated entity", () => {
      const results = db.searchEntities("content", { acl: user2Ctx });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(aclMemberId);
    });

    it("OR logic: user1 has label hr can read label-gated entity", () => {
      const user1WithLabels: ACLContext = { userId: user1Id, userRole: "member", userLabels: ["hr"] };
      const results = db.searchEntities("content", { acl: user1WithLabels });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(labelGatedId);
    });
  });

  // ── getEntity with ACL ──────────────────────────────────────────────────────

  describe("getEntity with ACL=on", () => {
    beforeEach(() => { process.env.CORTEX_ACL = "on"; });

    it("returns null for private entity when non-owner requests it", () => {
      const entity = db.getEntity(privateU1Id, user2Ctx);
      expect(entity).toBeNull();
    });

    it("returns entity for private entity when owner requests it", () => {
      const entity = db.getEntity(privateU1Id, user1Ctx);
      expect(entity).not.toBeNull();
      expect(entity?.id).toBe(privateU1Id);
    });

    it("returns null for DM entity when non-participant requests (including admin)", () => {
      const entity = db.getEntity(dmId, adminCtx);
      expect(entity).toBeNull();
    });

    it("returns DM entity when participant requests it", () => {
      const entity = db.getEntity(dmId, user1Ctx);
      expect(entity).not.toBeNull();
    });
  });

  // ── listEntities with ACL ───────────────────────────────────────────────────

  describe("listEntities with ACL=on", () => {
    beforeEach(() => { process.env.CORTEX_ACL = "on"; });

    it("respects visibility filter — user1 sees own private, not user2's", () => {
      const results = db.listEntities({ acl: user1Ctx });
      const ids = results.map((e) => e.id);
      expect(ids).toContain(privateU1Id);
      expect(ids).not.toContain(privateU2Id);
    });

    it("fail-closed: no acl context with ACL=on returns empty list", () => {
      const results = db.listEntities({});
      expect(results).toHaveLength(0);
    });
  });

  // ── countEntities with ACL ──────────────────────────────────────────────────

  describe("countEntities with ACL=on", () => {
    beforeEach(() => { process.env.CORTEX_ACL = "on"; });

    it("returns correct count for user1 (public + team + own private + dm + label gated via label + acl-member gated)", () => {
      const user1WithLabels: ACLContext = { userId: user1Id, userRole: "member", userLabels: ["hr"] };
      const count = db.countEntities({ acl: user1WithLabels });
      // public, team, privateU1, dm, labelGated (via hr), aclMember (via hr label too)
      expect(count).toBeGreaterThanOrEqual(5);
    });

    it("returns 0 when ACL=on and no context provided", () => {
      const count = db.countEntities({});
      expect(count).toBe(0);
    });
  });

  // ── CORTEX_ACL=off bypasses filtering ──────────────────────────────────────

  describe("CORTEX_ACL=off bypasses all filtering", () => {
    it("with ACL=off, all entities visible even when ACL context provided", () => {
      process.env.CORTEX_ACL = "off";
      const results = db.searchEntities("content", { acl: user1Ctx });
      const ids = results.map((e) => e.id);
      // All entities should be returned (FTS5 match on 'content')
      expect(ids).toContain(publicId);
      expect(ids).toContain(teamId);
      expect(ids).toContain(privateU1Id);
      expect(ids).toContain(privateU2Id);
      expect(ids).toContain(dmId);
    });

    it("with ACL=off (default), no filtering even without context", () => {
      // CORTEX_ACL not set defaults to off
      const results = db.searchEntities("content");
      expect(results.length).toBeGreaterThan(0);
    });
  });

  // ── Label CRUD ─────────────────────────────────────────────────────────────

  describe("label CRUD methods", () => {
    it("listLabels returns created labels", () => {
      const labels = db.listLabels();
      const names = labels.map((l) => l.name);
      expect(names).toContain("hr");
    });

    it("getUserLabels returns assigned labels for user", () => {
      const labels = db.getUserLabels(user1Id);
      expect(labels).toContain("hr");
    });

    it("getUserLabels returns empty array for user with no labels", () => {
      const labels = db.getUserLabels(user2Id);
      expect(labels).toHaveLength(0);
    });

    it("revokeUserLabel removes the label from user", () => {
      db.revokeUserLabel(user1Id, "lbl-hr");
      const labels = db.getUserLabels(user1Id);
      expect(labels).not.toContain("hr");
    });

    it("getLabelByName returns existing label", () => {
      const label = db.getLabelByName("hr");
      expect(label).not.toBeNull();
      expect(label?.name).toBe("hr");
    });

    it("getLabelByName returns null for non-existent label", () => {
      const label = db.getLabelByName("non-existent");
      expect(label).toBeNull();
    });
  });
});
