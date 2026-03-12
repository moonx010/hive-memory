import { describe, it, expect } from "vitest";
import { parseCliArgs } from "../src/cli.js";

describe("parseCliArgs", () => {
  it("parses store command with all options", () => {
    const args = parseCliArgs([
      "store",
      "--project", "myapp",
      "--category", "decision",
      "--agent", "codex-w1",
      "Use zod for validation",
    ]);
    expect(args.command).toBe("store");
    expect(args.project).toBe("myapp");
    expect(args.category).toBe("decision");
    expect(args.agent).toBe("codex-w1");
    expect(args.content).toBe("Use zod for validation");
  });

  it("parses recall command with json flag", () => {
    const args = parseCliArgs([
      "recall",
      "--query", "auth patterns",
      "--project", "myapp",
      "--limit", "3",
      "--json",
    ]);
    expect(args.command).toBe("recall");
    expect(args.query).toBe("auth patterns");
    expect(args.project).toBe("myapp");
    expect(args.limit).toBe(3);
    expect(args.json).toBe(true);
  });

  it("parses status command", () => {
    const args = parseCliArgs(["status", "--project", "myapp"]);
    expect(args.command).toBe("status");
    expect(args.project).toBe("myapp");
  });

  it("parses inject command", () => {
    const args = parseCliArgs([
      "inject",
      "--project", "myapp",
      "--query", "task context",
      "--output", "PROMPT.md",
      "--no-embed",
    ]);
    expect(args.command).toBe("inject");
    expect(args.project).toBe("myapp");
    expect(args.query).toBe("task context");
    expect(args.output).toBe("PROMPT.md");
    expect(args.noEmbed).toBe(true);
  });

  it("parses store without agent", () => {
    const args = parseCliArgs([
      "store",
      "--project", "myapp",
      "--category", "learning",
      "SQLite WAL is faster",
    ]);
    expect(args.command).toBe("store");
    expect(args.agent).toBeUndefined();
    expect(args.content).toBe("SQLite WAL is faster");
  });

  it("handles empty args", () => {
    const args = parseCliArgs([]);
    expect(args.command).toBe("");
  });

  it("parses sync command with project", () => {
    const args = parseCliArgs(["sync", "--project", "myapp"]);
    expect(args.command).toBe("sync");
    expect(args.project).toBe("myapp");
  });

  it("parses sync command without project", () => {
    const args = parseCliArgs(["sync"]);
    expect(args.command).toBe("sync");
    expect(args.project).toBeUndefined();
  });
});
