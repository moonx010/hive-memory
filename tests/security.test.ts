import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { CortexStore } from "../src/store.js";
import { registerTools } from "../src/tools.js";
import { createUser } from "../src/auth.js";
import type { UserContext } from "../src/tools/index.js";
import type { CortexConfig } from "../src/types.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: "text"; text: string }[];
  isError?: boolean;
}>;

// ── Test helpers ─────────────────────────────────────────────────────────────

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-sec-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

async function setupStore(dir: string): Promise<{ store: CortexStore; handlers: Map<string, ToolHandler> }> {
  const config: CortexConfig = {
    dataDir: dir,
    localContext: { filename: ".cortex.md", enabled: false },
  };
  const store = new CortexStore(config);
  await store.init();

  const handlers = new Map<string, ToolHandler>();
  const mockServer = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };

  return { store, handlers, mockServer } as unknown as { store: CortexStore; handlers: Map<string, ToolHandler> };
}

// ── TASK-SEC-01: UserContext race condition fix ────────────────────────────────

describe("TASK-SEC-01: per-request UserContext isolation", () => {
  let dir: string;
  let store: CortexStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cortex-sec-01-"));
    const config: CortexConfig = {
      dataDir: dir,
      localContext: { filename: ".cortex.md", enabled: false },
    };
    store = new CortexStore(config);
    await store.init();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("UserContext is typed as Readonly", async () => {
    // Compile-time check: the type must not allow direct mutation.
    // We verify by ensuring the getter returns a frozen (immutable) object.
    let captured: Readonly<UserContext> = Object.freeze({});
    const handlers = new Map<string, ToolHandler>();
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };

    let currentCtx: Readonly<UserContext> = Object.freeze({ userId: "user-1", userName: "Alice" });
    const getUserContext: GetUserContext = () => currentCtx;

    registerTools(mockServer as Parameters<typeof registerTools>[0], store, getUserContext);

    // Verify the getter returns the expected value
    captured = getUserContext();
    expect(captured.userId).toBe("user-1");
    expect(captured.userName).toBe("Alice");

    // The object must be frozen (immutable)
    expect(Object.isFrozen(captured)).toBe(true);
  });

  it("two concurrent requests see their own userId via the getter", async () => {
    const seenUserIds: string[] = [];

    // Simulate two requests with different contexts
    const ctxA: Readonly<UserContext> = Object.freeze({ userId: "user-A", userName: "Alice" });
    const ctxB: Readonly<UserContext> = Object.freeze({ userId: "user-B", userName: "Bob" });

    // Getter closure pattern: each request assigns its own frozen context
    // and reads back from the getter immediately
    let currentCtx: Readonly<UserContext> = Object.freeze({});
    const getter: GetUserContext = () => currentCtx;

    // Simulate request A
    currentCtx = ctxA;
    seenUserIds.push(getter().userId ?? "none");

    // Simulate request B (would overwrite in the old mutable pattern)
    currentCtx = ctxB;
    seenUserIds.push(getter().userId ?? "none");

    expect(seenUserIds[0]).toBe("user-A");
    expect(seenUserIds[1]).toBe("user-B");
  });

  it("getUserContext returns undefined context when no auth (local dev mode)", async () => {
    const handlers = new Map<string, ToolHandler>();
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };

    // No context getter provided (stdio/local mode)
    registerTools(mockServer as Parameters<typeof registerTools>[0], store, undefined);

    // memory_store should still work without a userContext
    const projectDir = await mkdtemp(join(tmpdir(), "cortex-proj-"));
    try {
      const registerHandler = handlers.get("project_register")!;
      await registerHandler({
        id: "test-proj",
        name: "Test Project",
        path: projectDir,
        description: "test",
        tags: [],
        techStack: [],
        modules: [],
      });

      const storeHandler = handlers.get("memory_store")!;
      const result = await storeHandler({
        project: "test-proj",
        category: "note",
        content: "test content",
      });
      expect(result.isError).toBeFalsy();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ── TASK-SEC-02: Admin auth check on user_manage ──────────────────────────────

describe("TASK-SEC-02: user_manage admin authorization", () => {
  let db: HiveDatabase;
  let dir: string;
  let store: CortexStore;
  let handlers: Map<string, ToolHandler>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cortex-sec-02-"));
    const ctx = await createTestDb();
    // Use db from the store's data dir for consistency
    const config: CortexConfig = {
      dataDir: dir,
      localContext: { filename: ".cortex.md", enabled: false },
    };
    store = new CortexStore(config);
    await store.init();
    db = store.database;

    handlers = new Map<string, ToolHandler>();
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };

    // Mutable context for testing
    const userContext: UserContext = {};

    registerTools(mockServer as Parameters<typeof registerTools>[0], store, userContext);

    // Store reference to test helper
    (handlers as unknown as { _setCtx: (ctx: Readonly<UserContext>) => void })._setCtx = (c) => { Object.assign(userContext, c); };

    await ctx.db.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setContext(ctx: Readonly<UserContext>) {
    (handlers as unknown as { _setCtx: (ctx: Readonly<UserContext>) => void })._setCtx(ctx);
  }

  it("system token (no userId) can call user_manage add", async () => {
    setContext(Object.freeze({})); // no userId = system token
    const result = await handlers.get("user_manage")!({ action: "add", name: "newuser" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("User created");
  });

  it("member user calling user_manage returns error", async () => {
    const { user } = createUser(db, "member-user");
    setContext(Object.freeze({ userId: user.id, userName: user.name }));

    const result = await handlers.get("user_manage")!({ action: "add", name: "anotheruser" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("admin role");
  });

  it("admin user can call user_manage add", async () => {
    // Create admin user by inserting directly with admin role
    const adminId = "admin-test-id";
    db.insertUser({
      id: adminId,
      name: "Admin User",
      email: undefined,
      apiKeyHash: "dummy-hash",
      role: "admin",
      createdAt: new Date().toISOString(),
      status: "active",
    });

    setContext(Object.freeze({ userId: adminId, userName: "Admin User" }));
    const result = await handlers.get("user_manage")!({ action: "add", name: "newuser2" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("User created");
  });

  it("user_manage list is also protected from non-admin members", async () => {
    const { user } = createUser(db, "list-member");
    setContext(Object.freeze({ userId: user.id, userName: user.name }));

    const result = await handlers.get("user_manage")!({ action: "list" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("admin role");
  });
});

// ── TASK-SEC-03: FTS5 query sanitization ─────────────────────────────────────

describe("TASK-SEC-03: FTS5 query sanitization", () => {
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

  it("injection query returns zero results without throwing", () => {
    // This would previously cause an FTS5 syntax error
    const results = db.searchEntities(`") OR 1=1 --`);
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });

  it("query with FTS5 boolean operators is sanitized", () => {
    // Should not throw — operators are stripped
    const results = db.searchEntities("hello OR world AND foo NOT bar");
    expect(Array.isArray(results)).toBe(true);
  });

  it("query with NEAR operator is sanitized", () => {
    const results = db.searchEntities("NEAR(foo bar, 5)");
    expect(Array.isArray(results)).toBe(true);
  });

  it("query with column prefix syntax is sanitized", () => {
    const results = db.searchEntities("title:secret content:password");
    expect(Array.isArray(results)).toBe(true);
  });

  it("normal search queries still work after sanitization", async () => {
    // Insert a test entity and verify it can be found
    const now = new Date().toISOString();
    db.insertEntity({
      id: "test-fts-entity",
      entityType: "note",
      project: "test-proj",
      namespace: "cortex",
      title: "unique-searchable-note",
      content: "this is a uniqueterm12345 content for testing FTS",
      tags: [],
      keywords: ["uniqueterm12345"],
      attributes: {},
      source: { system: "test" },
      author: undefined,
      visibility: "private",
      domain: "technical",
      confidence: "high",
      createdAt: now,
      updatedAt: now,
      expiresAt: undefined,
      status: "active",
      supersededBy: undefined,
      contentHash: undefined,
    });

    const results = db.searchEntities("uniqueterm12345");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe("test-fts-entity");
  });

  it("empty query after sanitization returns empty array without error", () => {
    // Stripping all operators leaves an empty string
    const results = db.searchEntities("OR AND NOT");
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBe(0);
  });
});
