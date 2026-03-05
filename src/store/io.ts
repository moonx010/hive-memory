import { readFile, writeFile, rename } from "node:fs/promises";

/** Validate that an ID is a safe slug (lowercase alphanumeric, hyphens, underscores, dots). */
export function validateId(id: string): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id) || id.includes("..")) {
    throw new Error(
      `Invalid ID "${id}": must be lowercase alphanumeric with hyphens/underscores/dots, no path traversal`,
    );
  }
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

/**
 * Write file atomically via temp + rename to prevent corruption
 * from concurrent writers (last-write-wins, no partial writes).
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
): Promise<void> {
  const tmp = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmp, data, "utf-8");
  await rename(tmp, filePath);
}

export async function writeJson(path: string, data: unknown): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(data, null, 2) + "\n");
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function getLastNSections(content: string, n: number): string {
  const sections = content.split(/^## /m).filter(Boolean);
  return sections
    .slice(-n)
    .map((s) => `## ${s}`)
    .join("");
}
