import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock, releaseLock } from "../src/store/lock.js";

describe("Lock", () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "hive-lock-test-"));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe("acquireLock / releaseLock", () => {
    it("acquires lock by creating lock directory with PID file", async () => {
      await acquireLock(dataDir);

      const lockPath = join(dataDir, ".lock", "hive.lock");
      expect(existsSync(lockPath)).toBe(true);

      const pid = await readFile(join(lockPath, "pid"), "utf-8");
      expect(Number(pid)).toBe(process.pid);

      await releaseLock(dataDir);
      expect(existsSync(lockPath)).toBe(false);
    });

    it("release is idempotent", async () => {
      await acquireLock(dataDir);
      await releaseLock(dataDir);
      // Second release should not throw
      await releaseLock(dataDir);
    });
  });

  describe("concurrent blocking", () => {
    it("blocks a second acquire while lock is held", async () => {
      await acquireLock(dataDir);

      // Second acquire should timeout (use short timeout by racing)
      const start = Date.now();
      const secondAcquire = acquireLock(dataDir);

      // Release after 300ms so second acquire succeeds
      setTimeout(async () => {
        await releaseLock(dataDir);
      }, 300);

      await secondAcquire;
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(200);

      await releaseLock(dataDir);
    });

    it("times out if lock is not released within 5s", async () => {
      await acquireLock(dataDir);

      // Manually write our own PID so it's not detected as stale
      // (it's our own process, so isPidAlive returns true)
      await expect(acquireLock(dataDir)).rejects.toThrow(
        /Failed to acquire hive lock/,
      );

      await releaseLock(dataDir);
    }, 10_000);
  });

  describe("stale lock recovery", () => {
    it("recovers from stale lock with dead PID", async () => {
      const lockPath = join(dataDir, ".lock", "hive.lock");
      await mkdir(lockPath, { recursive: true });
      // Write a PID that definitely doesn't exist (very high number)
      await writeFile(join(lockPath, "pid"), "9999999");

      // Should detect stale and acquire
      await acquireLock(dataDir);

      const pid = await readFile(join(lockPath, "pid"), "utf-8");
      expect(Number(pid)).toBe(process.pid);

      await releaseLock(dataDir);
    });

    it("recovers from stale lock with missing PID file", async () => {
      const lockPath = join(dataDir, ".lock", "hive.lock");
      await mkdir(lockPath, { recursive: true });
      // No PID file — should treat as stale

      await acquireLock(dataDir);

      const pid = await readFile(join(lockPath, "pid"), "utf-8");
      expect(Number(pid)).toBe(process.pid);

      await releaseLock(dataDir);
    });

    it("recovers from stale lock older than 30s", async () => {
      const lockPath = join(dataDir, ".lock", "hive.lock");
      await mkdir(lockPath, { recursive: true });
      // Write our own PID (alive) but we'll mock the age check
      // by creating a lock that appears old
      await writeFile(join(lockPath, "pid"), String(process.pid));

      // To simulate an old lock, we need to set the mtime in the past.
      // Use utimes to backdate the lock directory.
      const { utimes } = await import("node:fs/promises");
      const oldTime = new Date(Date.now() - 35_000);
      await utimes(lockPath, oldTime, oldTime);

      await acquireLock(dataDir);

      const pid = await readFile(join(lockPath, "pid"), "utf-8");
      expect(Number(pid)).toBe(process.pid);

      await releaseLock(dataDir);
    });
  });

  describe("lock with flush integration", () => {
    it("protects concurrent flush operations", async () => {
      // Simulate two concurrent operations using the lock
      let order: string[] = [];

      const op1 = (async () => {
        await acquireLock(dataDir);
        try {
          order.push("op1-start");
          await new Promise((r) => setTimeout(r, 100));
          order.push("op1-end");
        } finally {
          await releaseLock(dataDir);
        }
      })();

      const op2 = (async () => {
        // Small delay to ensure op1 acquires first
        await new Promise((r) => setTimeout(r, 20));
        await acquireLock(dataDir);
        try {
          order.push("op2-start");
          await new Promise((r) => setTimeout(r, 50));
          order.push("op2-end");
        } finally {
          await releaseLock(dataDir);
        }
      })();

      await Promise.all([op1, op2]);

      // op1 should complete before op2 starts
      expect(order).toEqual(["op1-start", "op1-end", "op2-start", "op2-end"]);
    });
  });
});
