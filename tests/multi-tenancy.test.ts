import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { createUser } from "../src/auth.js";

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-multitenancy-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

describe("multi-tenancy", () => {
  let db: HiveDatabase;
  let dir: string;

  beforeEach(async () => {
    const ctx = await createTestDb();
    db = ctx.db;
    dir = ctx.dir;
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  describe("create org + workspace", () => {
    it("creates an organization with correct fields", () => {
      const org = db.createOrganization("Acme Corp", "acme");
      expect(org.id).toBeTruthy();
      expect(org.name).toBe("Acme Corp");
      expect(org.slug).toBe("acme");
      expect(org.status).toBe("active");
      expect(org.createdAt).toBeTruthy();
    });

    it("creates a workspace under an organization", () => {
      const org = db.createOrganization("Acme Corp", "acme");
      const ws = db.createWorkspace(org.id, "Engineering", "engineering");
      expect(ws.id).toBeTruthy();
      expect(ws.orgId).toBe(org.id);
      expect(ws.name).toBe("Engineering");
      expect(ws.slug).toBe("engineering");
      expect(ws.status).toBe("active");
    });

    it("lists organizations", () => {
      db.createOrganization("Acme Corp", "acme");
      db.createOrganization("Globex", "globex");
      const orgs = db.listOrganizations();
      expect(orgs).toHaveLength(2);
      expect(orgs.map((o) => o.slug)).toContain("acme");
      expect(orgs.map((o) => o.slug)).toContain("globex");
    });

    it("lists workspaces for an org", () => {
      const org = db.createOrganization("Acme Corp", "acme");
      db.createWorkspace(org.id, "Engineering", "engineering");
      db.createWorkspace(org.id, "Marketing", "marketing");
      const workspaces = db.listWorkspaces(org.id);
      expect(workspaces).toHaveLength(2);
      expect(workspaces.map((w) => w.slug)).toContain("engineering");
      expect(workspaces.map((w) => w.slug)).toContain("marketing");
    });

    it("getOrganizationBySlug returns the org", () => {
      const org = db.createOrganization("Acme Corp", "acme");
      const found = db.getOrganizationBySlug("acme");
      expect(found).not.toBeNull();
      expect(found?.id).toBe(org.id);
    });

    it("getOrganizationBySlug returns null for unknown slug", () => {
      expect(db.getOrganizationBySlug("nonexistent")).toBeNull();
    });
  });

  describe("tenant isolation — entity scoping by org_id", () => {
    function insertEntity(orgId: string | undefined, content: string): string {
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      db.insertEntity({
        id,
        entityType: "memory",
        namespace: "local",
        content,
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
        orgId,
      });
      return id;
    }

    it("user in org A cannot see entities from org B", () => {
      insertEntity("org-a", "Org A entity");
      insertEntity("org-b", "Org B entity");

      const orgAEntities = db.listEntities({ orgId: "org-a" });
      expect(orgAEntities).toHaveLength(1);
      expect(orgAEntities[0].content).toBe("Org A entity");

      const orgBEntities = db.listEntities({ orgId: "org-b" });
      expect(orgBEntities).toHaveLength(1);
      expect(orgBEntities[0].content).toBe("Org B entity");
    });

    it("entity with org_id is scoped in searchEntities", () => {
      insertEntity("org-a", "Acme secret project data");
      insertEntity("org-b", "Globex secret project data");

      const orgAResults = db.searchEntities("secret project", { orgId: "org-a" });
      expect(orgAResults).toHaveLength(1);
      expect(orgAResults[0].content).toContain("Acme");

      const orgBResults = db.searchEntities("secret project", { orgId: "org-b" });
      expect(orgBResults).toHaveLength(1);
      expect(orgBResults[0].content).toContain("Globex");
    });

    it("user without org_id sees all entities (backward compat)", () => {
      insertEntity("org-a", "Org A entity");
      insertEntity("org-b", "Org B entity");
      insertEntity(undefined, "Global entity");

      // No orgId filter — sees everything
      const allEntities = db.listEntities({});
      expect(allEntities.length).toBeGreaterThanOrEqual(3);
    });

    it("orgId is persisted and retrievable via getEntity", () => {
      const id = insertEntity("org-a", "Org A content");
      const entity = db.getEntity(id);
      expect(entity).not.toBeNull();
      expect(entity?.orgId).toBe("org-a");
    });
  });

  describe("user org assignment", () => {
    it("assigns user to organization", () => {
      const org = db.createOrganization("Acme", "acme");
      const ws = db.createWorkspace(org.id, "default", "default");
      const { user } = createUser(db, "alice");

      db.assignUserToOrg(user.id, org.id, ws.id);

      const users = db.listUsers();
      const found = users.find((u) => u.id === user.id);
      expect(found?.orgId).toBe(org.id);
      expect(found?.workspaceId).toBe(ws.id);
    });

    it("createUser with orgId and workspaceId stores them correctly", () => {
      const org = db.createOrganization("Acme", "acme");
      const ws = db.createWorkspace(org.id, "default", "default");
      const now = new Date().toISOString();

      db.insertUser({
        id: "user-test-id",
        name: "bob",
        apiKeyHash: "abc123",
        role: "member",
        createdAt: now,
        status: "active",
        orgId: org.id,
        workspaceId: ws.id,
      });

      const users = db.listUsers();
      const found = users.find((u) => u.id === "user-test-id");
      expect(found?.orgId).toBe(org.id);
      expect(found?.workspaceId).toBe(ws.id);
    });
  });
});
