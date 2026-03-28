import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HiveDatabase } from "../src/db/database.js";
import { loadSSOConfig, provisionSSOUser } from "../src/auth/sso.js";

async function createTestDb(): Promise<{ db: HiveDatabase; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cortex-sso-test-"));
  const db = new HiveDatabase(join(dir, "test.db"));
  return { db, dir };
}

describe("loadSSOConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns disabled config when no env vars set", () => {
    vi.stubEnv("CORTEX_SSO_ENABLED", "");
    vi.stubEnv("CORTEX_SSO_PROVIDER", "");
    const config = loadSSOConfig();
    expect(config.enabled).toBe(false);
    expect(config.provider).toBe("none");
  });

  it("returns enabled config from env vars", () => {
    vi.stubEnv("CORTEX_SSO_ENABLED", "true");
    vi.stubEnv("CORTEX_SSO_PROVIDER", "oidc");
    vi.stubEnv("CORTEX_SSO_ISSUER_URL", "https://idp.example.com");
    vi.stubEnv("CORTEX_SSO_CLIENT_ID", "client-abc");
    vi.stubEnv("CORTEX_SSO_CLIENT_SECRET", "secret-xyz");
    const config = loadSSOConfig();
    expect(config.enabled).toBe(true);
    expect(config.provider).toBe("oidc");
    expect(config.issuerUrl).toBe("https://idp.example.com");
    expect(config.clientId).toBe("client-abc");
    expect(config.clientSecret).toBe("secret-xyz");
  });

  it("defaults provider to 'none' when env var not set", () => {
    vi.stubEnv("CORTEX_SSO_PROVIDER", "");
    const config = loadSSOConfig();
    expect(config.provider).toBe("none");
  });
});

describe("provisionSSOUser", () => {
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

  it("creates a new user when email does not exist", () => {
    const result = provisionSSOUser(db, { email: "alice@example.com", name: "Alice" });
    expect(result.isNew).toBe(true);
    expect(result.userId).toBeTruthy();
    expect(result.apiKey).toMatch(/^hm_/);
  });

  it("returns existing user when email already exists", () => {
    // First provision
    const first = provisionSSOUser(db, { email: "bob@example.com", name: "Bob" });
    expect(first.isNew).toBe(true);

    // Second provision with same email
    const second = provisionSSOUser(db, { email: "bob@example.com", name: "Bob" });
    expect(second.isNew).toBe(false);
    expect(second.userId).toBe(first.userId);
    expect(second.apiKey).toBe("");
  });

  it("assigns user to org when orgId is provided", () => {
    const org = db.createOrganization("TestOrg", "testorg");
    const result = provisionSSOUser(db, {
      email: "carol@example.com",
      name: "Carol",
      orgId: org.id,
    });
    expect(result.isNew).toBe(true);

    const users = db.listUsers();
    const user = users.find(u => u.id === result.userId);
    expect(user?.orgId).toBe(org.id);
  });

  it("does not assign org when orgId is not provided", () => {
    const result = provisionSSOUser(db, { email: "dave@example.com", name: "Dave" });
    const users = db.listUsers();
    const user = users.find(u => u.id === result.userId);
    expect(user?.orgId).toBeUndefined();
  });
});
