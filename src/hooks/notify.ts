/**
 * Generic outbound webhook notifier.
 * Fire-and-forget: logs errors, never throws.
 */

export interface HookPayload {
  event: string;
  entityId: string;
  timestamp: string;
  meta?: Record<string, unknown>;
}

export async function notifyHooks(payload: HookPayload): Promise<void> {
  const raw = process.env["CORTEX_WEBHOOK_NOTIFY_URLS"];
  if (!raw) return;

  const urls = raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (urls.length === 0) return;

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    urls.map(async (url) => {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          console.error(`[notify-hook] POST ${url} failed: ${res.status}`);
        }
      } catch (err) {
        console.error(`[notify-hook] POST ${url} error:`, err);
      }
    }),
  );
}
