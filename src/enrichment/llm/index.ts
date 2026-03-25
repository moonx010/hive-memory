import type { LLMProvider } from "../types.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import { BudgetedLLMProvider } from "./budget.js";

export function createLLMProvider(): LLMProvider | undefined {
  const enrichMode = process.env.CORTEX_ENRICHMENT ?? "rule";
  if (enrichMode !== "llm") return undefined;

  const provider = process.env.CORTEX_LLM_PROVIDER ?? "openai";
  const model = process.env.CORTEX_LLM_MODEL;
  const apiKey = process.env.CORTEX_LLM_API_KEY ?? "";
  const baseUrl = process.env.CORTEX_LLM_BASE_URL;

  if (provider !== "ollama" && !apiKey) {
    throw new Error(
      `CORTEX_LLM_API_KEY is required for LLM provider "${provider}"`,
    );
  }

  let inner: LLMProvider;
  switch (provider) {
    case "openai":
      inner = new OpenAIProvider(apiKey, model ?? "gpt-4o-mini");
      break;
    case "anthropic":
      inner = new AnthropicProvider(apiKey, model ?? "claude-haiku-4-5");
      break;
    case "ollama":
      inner = new OllamaProvider(
        baseUrl ?? "http://localhost:11434",
        model ?? "llama3",
      );
      break;
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }

  // Wrap with budget tracking and caching if configured
  const hasBudget =
    process.env.CORTEX_LLM_BUDGET_DAILY ||
    process.env.CORTEX_LLM_BUDGET_MONTHLY ||
    process.env.CORTEX_LLM_CACHE === "true";

  return hasBudget ? new BudgetedLLMProvider(inner) : inner;
}
