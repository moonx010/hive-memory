// In-memory metrics for observability

const MAX_LATENCIES = 100;

const counters = {
  requests: 0,
  errors: 0,
  syncRuns: 0,
  syncErrors: 0,
  toolCalls: new Map<string, number>(),
  latencies: [] as number[],
};

export function recordRequest(durationMs: number, error: boolean): void {
  counters.requests++;
  if (error) counters.errors++;

  counters.latencies.push(durationMs);
  if (counters.latencies.length > MAX_LATENCIES) {
    counters.latencies.shift();
  }
}

export function recordToolCall(toolName: string): void {
  const prev = counters.toolCalls.get(toolName) ?? 0;
  counters.toolCalls.set(toolName, prev + 1);
}

export function recordSync(connector: string, success: boolean): void {
  counters.syncRuns++;
  if (!success) counters.syncErrors++;
  // Track per-connector counts as tool calls (reuse map)
  const key = `sync:${connector}`;
  const prev = counters.toolCalls.get(key) ?? 0;
  counters.toolCalls.set(key, prev + 1);
}

export function getMetrics(): object {
  const latencies = counters.latencies;
  let p50 = 0;
  let p95 = 0;
  let p99 = 0;

  if (latencies.length > 0) {
    const sorted = [...latencies].sort((a, b) => a - b);
    p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  }

  const toolCallsObj: Record<string, number> = {};
  for (const [key, count] of counters.toolCalls.entries()) {
    toolCallsObj[key] = count;
  }

  return {
    requests: counters.requests,
    errors: counters.errors,
    errorRate: counters.requests > 0
      ? (counters.errors / counters.requests).toFixed(4)
      : "0",
    sync: {
      runs: counters.syncRuns,
      errors: counters.syncErrors,
    },
    latency: {
      p50,
      p95,
      p99,
      sampleSize: latencies.length,
    },
    toolCalls: toolCallsObj,
  };
}
