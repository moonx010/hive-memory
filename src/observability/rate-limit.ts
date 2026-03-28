// Per-user rate limiting (in-memory, adequate for single-instance Railway deployments)

const rateLimits = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT = 100; // requests per minute
const RATE_WINDOW_MS = 60_000;
const CLEANUP_INTERVAL_MS = 5 * 60_000; // sweep expired entries every 5 minutes
const MAX_ENTRIES = 10_000; // hard cap to prevent DoS via unique userId flooding

/** Remove expired entries to prevent unbounded memory growth */
function sweepExpired(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimits) {
    if (now > entry.resetAt) {
      rateLimits.delete(key);
    }
  }
}

// Periodic cleanup — unref'd so it won't keep the process alive
const _cleanupTimer = setInterval(sweepExpired, CLEANUP_INTERVAL_MS);
if (typeof _cleanupTimer.unref === "function") _cleanupTimer.unref();

export function checkRateLimit(userId: string): boolean {
  const now = Date.now();
  const entry = rateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    // Hard cap: reject if too many unique entries (DoS protection)
    if (!entry && rateLimits.size >= MAX_ENTRIES) {
      sweepExpired(); // try cleanup first
      if (rateLimits.size >= MAX_ENTRIES) return false;
    }
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}
