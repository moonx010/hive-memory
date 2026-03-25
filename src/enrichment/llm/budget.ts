import { createHash } from "node:crypto";
import type { LLMProvider } from "../types.js";

/**
 * LLM budget tracking and response caching wrapper.
 *
 * Environment variables:
 *   CORTEX_LLM_BUDGET_DAILY  — Max LLM calls per day (default: unlimited)
 *   CORTEX_LLM_BUDGET_MONTHLY — Max LLM calls per month (default: unlimited)
 *   CORTEX_LLM_CACHE — Enable response caching ("true" to enable)
 */

interface BudgetState {
  dailyCalls: number;
  monthlyCalls: number;
  dailyResetDate: string; // YYYY-MM-DD
  monthlyResetDate: string; // YYYY-MM
}

interface CacheEntry {
  response: string;
  createdAt: number;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

export class BudgetedLLMProvider implements LLMProvider {
  readonly model: string;
  private state: BudgetState;
  private cache = new Map<string, CacheEntry>();
  private readonly dailyLimit: number;
  private readonly monthlyLimit: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheTTLMs = 24 * 60 * 60 * 1000; // 24 hours

  constructor(private inner: LLMProvider) {
    this.model = inner.model;
    this.dailyLimit = parseInt(process.env.CORTEX_LLM_BUDGET_DAILY ?? "0", 10) || 0;
    this.monthlyLimit = parseInt(process.env.CORTEX_LLM_BUDGET_MONTHLY ?? "0", 10) || 0;
    this.cacheEnabled = process.env.CORTEX_LLM_CACHE === "true";

    const today = new Date().toISOString().split("T")[0];
    const month = today.slice(0, 7);
    this.state = {
      dailyCalls: 0,
      monthlyCalls: 0,
      dailyResetDate: today,
      monthlyResetDate: month,
    };
  }

  async complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    // Check cache
    if (this.cacheEnabled) {
      const cacheKey = this.hashPrompt(prompt, opts);
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt < this.cacheTTLMs) {
        return cached.response;
      }
    }

    this.checkBudget();
    this.incrementCounters();

    const response = await this.inner.complete(prompt, opts);

    // Store in cache
    if (this.cacheEnabled) {
      const cacheKey = this.hashPrompt(prompt, opts);
      this.cache.set(cacheKey, { response, createdAt: Date.now() });
      this.evictStaleCache();
    }

    return response;
  }

  async extract<T>(
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
    // Check cache
    if (this.cacheEnabled) {
      const cacheKey = this.hashPrompt(prompt + JSON.stringify(schema));
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt < this.cacheTTLMs) {
        return JSON.parse(cached.response) as T;
      }
    }

    this.checkBudget();
    this.incrementCounters();

    const result = await this.inner.extract<T>(prompt, schema);

    // Store in cache
    if (this.cacheEnabled) {
      const cacheKey = this.hashPrompt(prompt + JSON.stringify(schema));
      this.cache.set(cacheKey, {
        response: JSON.stringify(result),
        createdAt: Date.now(),
      });
      this.evictStaleCache();
    }

    return result;
  }

  /** Get current budget usage stats. */
  getStats(): {
    dailyCalls: number;
    monthlyCalls: number;
    dailyLimit: number;
    monthlyLimit: number;
    cacheSize: number;
    cacheEnabled: boolean;
  } {
    this.resetCountersIfNeeded();
    return {
      dailyCalls: this.state.dailyCalls,
      monthlyCalls: this.state.monthlyCalls,
      dailyLimit: this.dailyLimit,
      monthlyLimit: this.monthlyLimit,
      cacheSize: this.cache.size,
      cacheEnabled: this.cacheEnabled,
    };
  }

  private checkBudget(): void {
    this.resetCountersIfNeeded();

    if (this.dailyLimit > 0 && this.state.dailyCalls >= this.dailyLimit) {
      throw new BudgetError(
        `Daily LLM budget exceeded (${this.state.dailyCalls}/${this.dailyLimit}). Resets tomorrow.`,
      );
    }
    if (this.monthlyLimit > 0 && this.state.monthlyCalls >= this.monthlyLimit) {
      throw new BudgetError(
        `Monthly LLM budget exceeded (${this.state.monthlyCalls}/${this.monthlyLimit}). Resets next month.`,
      );
    }
  }

  private incrementCounters(): void {
    this.state.dailyCalls++;
    this.state.monthlyCalls++;
  }

  private resetCountersIfNeeded(): void {
    const today = new Date().toISOString().split("T")[0];
    const month = today.slice(0, 7);

    if (this.state.dailyResetDate !== today) {
      this.state.dailyCalls = 0;
      this.state.dailyResetDate = today;
    }
    if (this.state.monthlyResetDate !== month) {
      this.state.monthlyCalls = 0;
      this.state.monthlyResetDate = month;
    }
  }

  private hashPrompt(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): string {
    const input = opts
      ? `${prompt}:${opts.maxTokens ?? ""}:${opts.temperature ?? ""}`
      : prompt;
    return createHash("sha256").update(input).digest("hex").slice(0, 32);
  }

  private evictStaleCache(): void {
    if (this.cache.size <= 1000) return;
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.createdAt > this.cacheTTLMs) {
        this.cache.delete(key);
      }
    }
  }
}
