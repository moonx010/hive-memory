import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import {
  createUser,
  verifyToken,
  listUsers,
  revokeUser,
  generateApiKey,
  hashApiKey,
  resolveAuth,
} from "../src/auth.js";

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-auth-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

describe("auth module", () => {
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

  describe("generateApiKey", () => {
    it("returns a plaintext key starting with hm_", () => {
      const { plaintext } = generateApiKey();
      expect(plaintext).toMatch(/^hm_[0-9a-f]{64}$/);
    });

    it("returns a 64-char hex hash", () => {
      const { hash } = generateApiKey();
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("generates unique keys each call", () => {
      const a = generateApiKey();
      const b = generateApiKey();
      expect(a.plaintext).not.toBe(b.plaintext);
      expect(a.hash).not.toBe(b.hash);
    });
  });

  describe("hashApiKey", () => {
    it("is deterministic — same input produces same hash", () => {
      const key = "hm_test_key_value";
      expect(hashApiKey(key)).toBe(hashApiKey(key));
    });

    it("different inputs produce different hashes", () => {
      expect(hashApiKey("hm_aaa")).not.toBe(hashApiKey("hm_bbb"));
    });
  });

  describe("createUser", () => {
    it("returns a plaintext API key starting with hm_", () => {
      const { plaintextKey } = createUser(db, "alice");
      expect(plaintextKey).toMatch(/^hm_/);
    });

    it("returns user with correct name and default role", () => {
      const { user } = createUser(db, "bob", "bob@example.com");
      expect(user.name).toBe("bob");
      expect(user.email).toBe("bob@example.com");
      expect(user.role).toBe("member");
      expect(user.status).toBe("active");
      expect(user.id).toBeTruthy();
    });

    it("creates user without email", () => {
      const { user } = createUser(db, "charlie");
      expect(user.email).toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("returns user for a valid key", () => {
      const { user, plaintextKey } = createUser(db, "alice");
      const result = verifyToken(db, plaintextKey);
      expect(result).not.toBeNull();
      expect(result?.id).toBe(user.id);
      expect(result?.name).toBe("alice");
    });

    it("returns null for an invalid key", () => {
      createUser(db, "alice");
      const result = verifyToken(db, "hm_invalid_key_that_does_not_exist");
      expect(result).toBeNull();
    });

    it("returns null for an empty string", () => {
      expect(verifyToken(db, "")).toBeNull();
    });
  });

  describe("revokeUser", () => {
    it("makes the API key invalid after revocation", () => {
      const { user, plaintextKey } = createUser(db, "dave");
      expect(verifyToken(db, plaintextKey)).not.toBeNull();

      revokeUser(db, user.id);

      expect(verifyToken(db, plaintextKey)).toBeNull();
    });

    it("revoked user still appears in listUsers with revoked status", () => {
      const { user } = createUser(db, "eve");
      revokeUser(db, user.id);
      const users = listUsers(db);
      const found = users.find((u) => u.id === user.id);
      expect(found).toBeDefined();
      expect(found?.status).toBe("revoked");
    });
  });

  describe("listUsers", () => {
    it("returns all users (active and revoked)", () => {
      const { user: u1 } = createUser(db, "frank");
      const { user: u2 } = createUser(db, "grace");
      revokeUser(db, u1.id);
      const users = listUsers(db);
      expect(users.length).toBe(2);
      expect(users.map((u) => u.name)).toContain("frank");
      expect(users.map((u) => u.name)).toContain("grace");
    });

    it("returns empty array when no users", () => {
      expect(listUsers(db)).toEqual([]);
    });
  });

  describe("resolveAuth", () => {
    it("authenticates with a valid user token", () => {
      const { user, plaintextKey } = createUser(db, "hank");
      const ctx = resolveAuth(db, `Bearer ${plaintextKey}`, undefined);
      expect(ctx.authorized).toBe(true);
      expect(ctx.userId).toBe(user.id);
      expect(ctx.userName).toBe("hank");
    });

    it("authenticates with CORTEX_AUTH_TOKEN (admin fallback)", () => {
      const ctx = resolveAuth(db, "Bearer secret-admin-token", "secret-admin-token");
      expect(ctx.authorized).toBe(true);
      expect(ctx.userId).toBeUndefined();
    });

    it("rejects when admin token set but wrong token provided", () => {
      const ctx = resolveAuth(db, "Bearer wrong-token", "secret-admin-token");
      expect(ctx.authorized).toBe(false);
    });

    it("rejects when active users exist but bad token provided", () => {
      createUser(db, "iris");
      const ctx = resolveAuth(db, "Bearer bad-token", undefined);
      expect(ctx.authorized).toBe(false);
    });

    it("allows all requests when no auth configured (local dev mode)", () => {
      // No users, no admin token
      const ctx = resolveAuth(db, undefined, undefined);
      expect(ctx.authorized).toBe(true);
    });

    it("rejects revoked user token", () => {
      const { user, plaintextKey } = createUser(db, "jane");
      revokeUser(db, user.id);
      const ctx = resolveAuth(db, `Bearer ${plaintextKey}`, undefined);
      expect(ctx.authorized).toBe(false);
    });
  });
});
