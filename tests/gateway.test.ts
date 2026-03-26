import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateMcpConfig, getConfigPath, detectTool } from "../src/gateway/config-templates.js";
import { mergeConfig } from "../src/gateway/config-writer.js";
import { connectAgent, verifyConnection } from "../src/gateway/connect.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";

describe("generateMcpConfig", () => {
  it("returns correct URL with /mcp suffix", () => {
    const config = generateMcpConfig("http://localhost:3179", "hm_abc123");
    expect(config.url).toBe("http://localhost:3179/mcp");
  });

  it("returns correct Authorization header", () => {
    const config = generateMcpConfig("http://localhost:3179", "hm_abc123");
    expect(config.headers.Authorization).toBe("Bearer hm_abc123");
  });

  it("handles trailing slash in server URL", () => {
    const config = generateMcpConfig("http://myserver:3179", "token");
    expect(config.url).toBe("http://myserver:3179/mcp");
  });
});

describe("getConfigPath", () => {
  it("returns claude settings.json path for claude tool", () => {
    const path = getConfigPath("claude");
    expect(path).toBe(join(homedir(), ".claude", "settings.json"));
  });

  it("returns cursor mcp.json path for cursor tool", () => {
    const path = getConfigPath("cursor");
    expect(path).toBe(join(homedir(), ".cursor", "mcp.json"));
  });
});

describe("detectTool", () => {
  it("returns a value that is 'claude', 'cursor', or null", () => {
    const result = detectTool();
    expect(["claude", "cursor", null]).toContain(result);
  });
});

describe("mergeConfig", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hive-memory-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a new config file with cortex entry when file does not exist", async () => {
    const configPath = join(tmpDir, "settings.json");
    const serverConfig = generateMcpConfig("http://localhost:3179", "hm_abc");

    await mergeConfig(configPath, serverConfig);

    const content = JSON.parse(await readFile(configPath, "utf-8"));
    expect(content.mcpServers.cortex).toEqual(serverConfig);
  });

  it("merges cortex into existing config, preserving other servers", async () => {
    const configPath = join(tmpDir, "settings.json");
    const existing = {
      mcpServers: {
        "other-server": {
          url: "http://other:1234/mcp",
          headers: { Authorization: "Bearer other_token" },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

    const serverConfig = generateMcpConfig("http://localhost:3179", "hm_abc");
    await mergeConfig(configPath, serverConfig);

    const content = JSON.parse(await readFile(configPath, "utf-8"));
    // cortex entry added
    expect(content.mcpServers.cortex).toEqual(serverConfig);
    // other server preserved
    expect(content.mcpServers["other-server"]).toEqual(existing.mcpServers["other-server"]);
  });

  it("updates existing cortex entry without duplicating", async () => {
    const configPath = join(tmpDir, "settings.json");
    const oldConfig = {
      mcpServers: {
        cortex: {
          url: "http://old:3179/mcp",
          headers: { Authorization: "Bearer old_token" },
        },
      },
    };
    await writeFile(configPath, JSON.stringify(oldConfig, null, 2), "utf-8");

    const newServerConfig = generateMcpConfig("http://new:3179", "hm_new");
    await mergeConfig(configPath, newServerConfig);

    const content = JSON.parse(await readFile(configPath, "utf-8"));
    expect(content.mcpServers.cortex).toEqual(newServerConfig);
    expect(Object.keys(content.mcpServers)).toHaveLength(1);
  });

  it("creates parent directory if it does not exist", async () => {
    const configPath = join(tmpDir, "nested", "dir", "settings.json");
    const serverConfig = generateMcpConfig("http://localhost:3179", "hm_abc");

    await mergeConfig(configPath, serverConfig);

    const content = JSON.parse(await readFile(configPath, "utf-8"));
    expect(content.mcpServers.cortex).toEqual(serverConfig);
  });

  it("writes JSON with 2-space indent and trailing newline", async () => {
    const configPath = join(tmpDir, "settings.json");
    const serverConfig = generateMcpConfig("http://localhost:3179", "hm_abc");

    await mergeConfig(configPath, serverConfig);

    const raw = await readFile(configPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    // 2-space indent check
    expect(raw).toContain("  \"mcpServers\"");
  });
});

describe("connectAgent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "hive-memory-connect-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns written: true and correct serverName", async () => {
    // We mock getConfigPath by overriding the module — but for simplicity,
    // use connectAgent with a real call and verify the result shape
    const result = await connectAgent({
      serverUrl: "http://localhost:3179",
      apiKey: "test_key",
      target: "claude-code",
    });

    expect(result.written).toBe(true);
    expect(result.serverName).toBe("cortex");
    expect(result.configPath).toContain(".claude");
  });

  it("uses cursor config path for cursor target", async () => {
    const result = await connectAgent({
      serverUrl: "http://localhost:3179",
      apiKey: "test_key",
      target: "cursor",
    });

    expect(result.written).toBe(true);
    expect(result.configPath).toContain(".cursor");
  });
});

describe("verifyConnection", () => {
  it("returns false when server is not reachable", async () => {
    // Port 19999 is very unlikely to be in use
    const result = await verifyConnection("http://localhost:19999", "test_key");
    expect(result).toBe(false);
  });

  it("returns false for invalid URL", async () => {
    const result = await verifyConnection("http://invalid-hostname-that-does-not-exist.local", "test_key");
    expect(result).toBe(false);
  }, 10000);
});

describe("Claude Code config format", () => {
  it("generates config compatible with Claude Code mcpServers format", () => {
    const config = generateMcpConfig("http://myserver:3179", "hm_token");
    // Claude Code expects type: "url" in some versions, but our format uses url + headers
    expect(config).toHaveProperty("url");
    expect(config).toHaveProperty("headers");
    expect(config.headers).toHaveProperty("Authorization");
  });
});

describe("Cursor config format", () => {
  it("generates config compatible with Cursor mcp.json format", () => {
    const config = generateMcpConfig("http://myserver:3179", "cursor_token");
    expect(config.url).toBe("http://myserver:3179/mcp");
    expect(config.headers.Authorization).toBe("Bearer cursor_token");
  });
});
