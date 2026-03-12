import { mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

const STALE_TIMEOUT_MS = 30_000;
const RETRY_INTERVAL_MS = 100;
const ACQUIRE_TIMEOUT_MS = 5_000;

function lockDir(dataDir: string): string {
  return join(dataDir, ".lock", "hive.lock");
}

function pidFile(dataDir: string): string {
  return join(lockDir(dataDir), "pid");
}

/**
 * Check if a PID is alive by sending signal 0.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an existing lock is stale:
 * - Process no longer alive, OR
 * - Lock older than STALE_TIMEOUT_MS
 */
async function isLockStale(dataDir: string): Promise<boolean> {
  try {
    const pidContent = await readFile(pidFile(dataDir), "utf-8");
    const pid = Number(pidContent.trim());

    if (!Number.isFinite(pid) || pid <= 0) {
      return true;
    }

    // If the process is dead, it's stale
    if (!isPidAlive(pid)) {
      return true;
    }

    // If lock is older than timeout, it's stale
    const lockStat = await stat(lockDir(dataDir));
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs > STALE_TIMEOUT_MS) {
      return true;
    }

    return false;
  } catch {
    // If we can't read the PID file, treat as stale
    return true;
  }
}

/**
 * Try to create the lock directory atomically.
 * Returns true if lock was acquired, false if already held.
 */
async function tryAcquire(dataDir: string): Promise<boolean> {
  try {
    // Ensure parent .lock dir exists
    await mkdir(join(dataDir, ".lock"), { recursive: true });
    // Atomic: mkdir throws EEXIST if lock already held
    await mkdir(lockDir(dataDir), { recursive: false });
    // Write PID file inside lock dir
    await writeFile(pidFile(dataDir), String(process.pid));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

/**
 * Acquire the flush lock. Retries with backoff up to ACQUIRE_TIMEOUT_MS.
 * Handles stale lock detection and recovery.
 */
export async function acquireLock(dataDir: string): Promise<void> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  let staleCleaned = false;

  while (Date.now() < deadline) {
    if (await tryAcquire(dataDir)) {
      return;
    }

    // Lock exists — check if stale (only try once)
    if (!staleCleaned && (await isLockStale(dataDir))) {
      try {
        await rm(lockDir(dataDir), { recursive: true, force: true });
        staleCleaned = true;
        // Retry acquire immediately
        if (await tryAcquire(dataDir)) {
          return;
        }
      } catch {
        // Another process may have cleaned it; continue retrying
      }
    }

    // Wait before retry
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  throw new Error(
    `Failed to acquire hive lock after ${ACQUIRE_TIMEOUT_MS}ms: ${lockDir(dataDir)}`,
  );
}

/**
 * Release the flush lock by removing the lock directory.
 */
export async function releaseLock(dataDir: string): Promise<void> {
  await rm(lockDir(dataDir), { recursive: true, force: true });
}
