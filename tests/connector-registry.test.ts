import { describe, it, expect } from "vitest";
import { ConnectorRegistry, BUILT_IN_CONNECTORS } from "../src/connectors/registry.js";
import type { ConnectorManifest } from "../src/connectors/registry.js";

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

describe("ConnectorRegistry", () => {
  let registry: ConnectorRegistry;

  registry = new ConnectorRegistry();

  it("register and list — registered connector appears in list", () => {
    registry = new ConnectorRegistry();
    registry.register(makeManifest({ id: "my-connector" }));
    const all = registry.list();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("my-connector");
  });

  it("get returns the manifest by id", () => {
    registry = new ConnectorRegistry();
    const manifest = makeManifest({ id: "abc" });
    registry.register(manifest);
    expect(registry.get("abc")).toEqual(manifest);
  });

  it("get returns undefined for unknown id", () => {
    registry = new ConnectorRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("configured is true when all required env vars are set", () => {
    registry = new ConnectorRegistry();
    const originalVal = process.env.TEST_TOKEN;
    process.env.TEST_TOKEN = "my-token";

    try {
      registry.register(makeManifest({ requiredEnvVars: ["TEST_TOKEN"] }));
      const [item] = registry.list();
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
    registry = new ConnectorRegistry();
    const key = "DEFINITELY_NOT_SET_VAR_12345";
    delete process.env[key];

    registry.register(makeManifest({ requiredEnvVars: [key] }));
    const [item] = registry.list();
    expect(item.configured).toBe(false);
  });

  it("configured is false when only some required env vars are set", () => {
    registry = new ConnectorRegistry();
    const setKey = "TEST_SET_KEY_12345";
    const unsetKey = "TEST_UNSET_KEY_12345";
    process.env[setKey] = "value";
    delete process.env[unsetKey];

    try {
      registry.register(makeManifest({ requiredEnvVars: [setKey, unsetKey] }));
      const [item] = registry.list();
      expect(item.configured).toBe(false);
    } finally {
      delete process.env[setKey];
    }
  });

  it("list returns spread copies — modifying result does not affect registry", () => {
    registry = new ConnectorRegistry();
    registry.register(makeManifest({ id: "stable" }));
    const result = registry.list();
    result[0].id = "mutated";
    expect(registry.get("stable")).toBeDefined();
  });

  it("multiple connectors can be registered", () => {
    registry = new ConnectorRegistry();
    registry.register(makeManifest({ id: "a" }));
    registry.register(makeManifest({ id: "b" }));
    registry.register(makeManifest({ id: "c" }));
    expect(registry.list()).toHaveLength(3);
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

  it("can be registered into registry", () => {
    const registry = new ConnectorRegistry();
    for (const manifest of BUILT_IN_CONNECTORS) {
      registry.register(manifest);
    }
    expect(registry.list()).toHaveLength(BUILT_IN_CONNECTORS.length);
  });
});
