import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ConnectorMarketplace, BUILT_IN_CONNECTORS } from "../src/connectors/marketplace.js";
import type { ConnectorManifest } from "../src/connectors/marketplace.js";

function makeManifest(overrides: Partial<ConnectorManifest> = {}): ConnectorManifest {
  return {
    id: "test-connector",
    name: "Test Connector",
    description: "A test connector",
    version: "1.0.0",
    author: "test",
    entityTypes: ["document"],
    domains: ["test"],
    requiredEnvVars: ["TEST_TOKEN"],
    ...overrides,
  };
}

describe("ConnectorMarketplace", () => {
  let marketplace: ConnectorMarketplace;

  beforeEach(() => {
    marketplace = new ConnectorMarketplace();
  });

  it("register and list — registered connector appears in list", () => {
    marketplace.register(makeManifest({ id: "my-connector" }));
    const all = marketplace.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("my-connector");
  });

  it("get returns the manifest by id", () => {
    const manifest = makeManifest({ id: "abc" });
    marketplace.register(manifest);
    expect(marketplace.get("abc")).toEqual(manifest);
  });

  it("get returns undefined for unknown id", () => {
    expect(marketplace.get("nonexistent")).toBeUndefined();
  });

  it("configured is true when all required env vars are set", () => {
    const originalVal = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = "my-token";

    try {
      marketplace.register(makeManifest({ requiredEnvVars: ["TEST_TOKEN"] }));
      const [item] = marketplace.list();
      expect(item.configured).toBe(true);
    } finally {
      if (originalVal === undefined) {
        delete process.env.TEST_TOKEN;
      } else {
        process.env.TEST_TOKEN = originalVal;
      }
    }
  });

  it("configured is false when a required env var is missing", () => {
    const key = "DEFINITELY_NOT_SET_VAR_12345";
    delete process.env[key];

    marketplace.register(makeManifest({ requiredEnvVars: [key] }));
    const [item] = marketplace.list();
    expect(item.configured).toBe(false);
  });

  it("configured is false when only some required env vars are set", () => {
    const setKey = "TEST_SET_KEY_12345";
    const unsetKey = "TEST_UNSET_KEY_12345";
    process.env[setKey] = "value";
    delete process.env[unsetKey];

    try {
      marketplace.register(makeManifest({ requiredEnvVars: [setKey, unsetKey] }));
      const [item] = marketplace.list();
      expect(item.configured).toBe(false);
    } finally {
      delete process.env[setKey];
    }
  });

  it("list returns spread copies — modifying result does not affect registry", () => {
    marketplace.register(makeManifest({ id: "stable" }));
    const result = marketplace.list();
    result[0].id = "mutated";
    expect(marketplace.get("stable")).toBeDefined();
  });

  it("multiple connectors can be registered", () => {
    marketplace.register(makeManifest({ id: "a" }));
    marketplace.register(makeManifest({ id: "b" }));
    marketplace.register(makeManifest({ id: "c" }));
    expect(marketplace.list()).toHaveLength(3);
  });
});

describe("BUILT_IN_CONNECTORS", () => {
  it("all built-in connectors have required fields", () => {
    for (const c of BUILT_IN_CONNECTORS) {
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);
      expect(typeof c.name).toBe("string");
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.description).toBe("string");
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.version).toBe("string");
      expect(c.version.length).toBeGreaterThan(0);
      expect(typeof c.author).toBe("string");
      expect(c.author.length).toBeGreaterThan(0);
      expect(Array.isArray(c.entityTypes)).toBe(true);
      expect(c.entityTypes.length).toBeGreaterThan(0);
      expect(Array.isArray(c.domains)).toBe(true);
      expect(c.domains.length).toBeGreaterThan(0);
      expect(Array.isArray(c.requiredEnvVars)).toBe(true);
    }
  });

  it("contains expected connector ids", () => {
    const ids = BUILT_IN_CONNECTORS.map(c => c.id);
    expect(ids).toContain("github");
    expect(ids).toContain("slack");
    expect(ids).toContain("notion");
    expect(ids).toContain("google-calendar");
    expect(ids).toContain("outlook");
  });

  it("can be registered into marketplace", () => {
    const marketplace = new ConnectorMarketplace();
    for (const manifest of BUILT_IN_CONNECTORS) {
      marketplace.register(manifest);
    }
    expect(marketplace.list()).toHaveLength(BUILT_IN_CONNECTORS.length);
  });
});
