import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename } from "node:path";
import type { OnboardCandidate } from "../types.js";
import type { ProjectStore } from "./project-store.js";

export class OnboardScanner {
  constructor(private projectStore: ProjectStore) {}

  async scanForProjects(
    rootPath: string,
    depth = 1,
  ): Promise<OnboardCandidate[]> {
    const index = await this.projectStore.getIndex();
    const registeredPaths = new Set(index.projects.map((p) => p.path));
    const registeredIds = new Set(index.projects.map((p) => p.id));
    const candidates: OnboardCandidate[] = [];

    const scan = async (dir: string, currentDepth: number) => {
      if (currentDepth > depth) return;
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        return;
      }

      const detected = await detectProject(dir);
      if (detected) {
        detected.alreadyRegistered =
          registeredPaths.has(dir) || registeredIds.has(detected.suggestedId);
        candidates.push(detected);
        return;
      }

      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules" || entry === "target" || entry === "dist") continue;
        const fullPath = join(dir, entry);
        try {
          const s = await stat(fullPath);
          if (s.isDirectory()) {
            await scan(fullPath, currentDepth + 1);
          }
        } catch {
          continue;
        }
      }
    };

    await scan(rootPath, 0);
    return candidates;
  }
}

async function detectProject(dir: string): Promise<OnboardCandidate | null> {
  const hasFile = (name: string) => existsSync(join(dir, name));

  const hasPackageJson = hasFile("package.json");
  const hasCargoToml = hasFile("Cargo.toml");
  const hasGit = hasFile(".git");
  const hasPyproject = hasFile("pyproject.toml");
  const hasGoMod = hasFile("go.mod");

  if (!hasPackageJson && !hasCargoToml && !hasGit && !hasPyproject && !hasGoMod) {
    return null;
  }

  const dirName = basename(dir);
  let suggestedName = dirName;
  let description = "";
  const techStack: string[] = [];
  const modules: string[] = [];
  const tags: string[] = [];

  if (hasPackageJson) {
    try {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf-8"));
      if (pkg.name) suggestedName = pkg.name.replace(/^@[^/]+\//, "");
      if (pkg.description) description = pkg.description;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps["react"] || deps["react-dom"]) techStack.push("React");
      if (deps["next"]) techStack.push("Next.js");
      if (deps["vue"]) techStack.push("Vue");
      if (deps["svelte"]) techStack.push("Svelte");
      if (deps["typescript"]) techStack.push("TypeScript");
      if (deps["@anthropic-ai/sdk"]) techStack.push("Anthropic SDK");
      if (deps["@modelcontextprotocol/sdk"]) techStack.push("MCP SDK");
      if (deps["express"] || deps["fastify"] || deps["hono"]) techStack.push("Node.js");
      if (deps["tailwindcss"]) tags.push("tailwind");
      if (deps["@tauri-apps/api"]) techStack.push("Tauri");
      if (deps["vitest"] || deps["jest"]) tags.push("tested");
      if (!techStack.includes("TypeScript") && !techStack.includes("Node.js")) {
        techStack.push("Node.js");
      }
    } catch { /* ignore parse errors */ }
  }

  if (hasCargoToml) {
    try {
      const cargo = await readFile(join(dir, "Cargo.toml"), "utf-8");
      techStack.push("Rust");
      const nameMatch = cargo.match(/^name\s*=\s*"(.+)"/m);
      if (nameMatch && !hasPackageJson) suggestedName = nameMatch[1];
      const descMatch = cargo.match(/^description\s*=\s*"(.+)"/m);
      if (descMatch && !description) description = descMatch[1];
      if (cargo.includes("tokio")) techStack.push("tokio");
      if (cargo.includes("[workspace]")) {
        const membersMatch = cargo.match(/members\s*=\s*\[([\s\S]*?)\]/);
        if (membersMatch) {
          const members = membersMatch[1].match(/"([^"]+)"/g);
          if (members) {
            modules.push(...members.map((m) => m.replace(/"/g, "").replace(/.*\//, "")));
          }
        }
      }
    } catch { /* ignore */ }
  }

  if (hasPyproject) {
    try {
      const content = await readFile(join(dir, "pyproject.toml"), "utf-8");
      techStack.push("Python");
      const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
      if (nameMatch && !hasPackageJson && !hasCargoToml) suggestedName = nameMatch[1];
      const descMatch = content.match(/^description\s*=\s*"(.+)"/m);
      if (descMatch && !description) description = descMatch[1];
      if (content.includes("torch")) techStack.push("PyTorch");
      if (content.includes("fastapi")) techStack.push("FastAPI");
    } catch { /* ignore */ }
  }

  if (hasGoMod) {
    techStack.push("Go");
  }

  const suggestedId = dirName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  tags.push(...techStack.map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, "")));

  if (!description) {
    description = `${suggestedName} project`;
  }

  return {
    path: dir,
    suggestedId,
    suggestedName,
    description,
    techStack: [...new Set(techStack)],
    modules,
    tags: [...new Set(tags)],
    alreadyRegistered: false,
  };
}
