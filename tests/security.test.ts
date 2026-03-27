import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { CortexStore } from "../src/store.js";
import { registerTools } from "../src/tools.js";
import { createUser } from "../src/auth.js";
import type { CortexConfig } from "../src/types.js";
import { requestContext } from "../src/request-context.js";

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

// Helper to call a tool handler inside a request context
async function callWithContext(
  handler: ToolHandler,
  args: Record<string, unknown>,
  ctx: { userId?: string; userName?: string },
) {
  return requestContext.run(ctx, () => handler(args));
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

  it("AsyncLocalStorage returns correct userId per request context", async () => {
    const ctxA = Object.freeze({ userId: "user-A", userName: "Alice" });
    const ctxB = Object.freeze({ userId: "user-B", userName: "Bob" });

    const resultsA: string[] = [];
    const resultsB: string[] = [];

    // Simulate two requests running with different contexts
    await Promise.all([
      requestContext.run(ctxA, async () => {
        resultsA.push(requestContext.getStore()?.userId ?? "none");
      }),
      requestContext.run(ctxB, async () => {
        resultsB.push(requestContext.getStore()?.userId ?? "none");
      }),
    ]);

    expect(resultsA[0]).toBe("user-A");
    expect(resultsB[0]).toBe("user-B");
  });

  it("two concurrent requests see their own userId via the getter", async () => {
    const seenUserIds: string[] = [];

    await Promise.all([
      requestContext.run({ userId: "user-A" }, async () => {
        seenUserIds[0] = requestContext.getStore()?.userId ?? "none";
      }),
      requestContext.run({ userId: "user-B" }, async () => {
        seenUserIds[1] = requestContext.getStore()?.userId ?? "none";
      }),
    ]);

    expect(seenUserIds[0]).toBe("user-A");
    expect(seenUserIds[1]).toBe("user-B");
  });

  it("getCurrentRequestContext returns undefined context when no request (local dev mode)", async () => {
    const handlers = new Map<string, ToolHandler>();
    const mockServer = {
      tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        handlers.set(name, handler);
      },
    };

    registerTools(mockServer as Parameters<typeof registerTools>[0], store);

    // memory_store should still work without a request context (stdio/local mode)
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

    registerTools(mockServer as Parameters<typeof registerTools>[0], store);

    await ctx.db.close();
    await rm(ctx.dir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("system token (no userId) can call user_manage add", async () => {
    const result = await callWithContext(
      handlers.get("user_manage")!,
      { action: "add", name: "newuser" },
      {}, // no userId = system token
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("User created");
  });

  it("member user calling user_manage returns error", async () => {
    const { user } = createUser(db, "member-user");

    const result = await callWithContext(
      handlers.get("user_manage")!,
      { action: "add", name: "anotheruser" },
      { userId: user.id, userName: user.name },
    );
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

    const result = await callWithContext(
      handlers.get("user_manage")!,
      { action: "add", name: "newuser2" },
      { userId: adminId, userName: "Admin User" },
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("User created");
  });

  it("user_manage list is also protected from non-admin members", async () => {
    const { user } = createUser(db, "list-member");

    const result = await callWithContext(
      handlers.get("user_manage")!,
      { action: "list" },
      { userId: user.id, userName: user.name },
    );
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
