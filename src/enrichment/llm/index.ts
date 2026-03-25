import type { LLMProvider } from "../types.js";
import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";

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

  switch (provider) {
    case "openai":
      return new OpenAIProvider(apiKey, model ?? "gpt-4o-mini");
    case "anthropic":
      return new AnthropicProvider(apiKey, model ?? "claude-haiku-4-5");
    case "ollama":
      return new OllamaProvider(
        baseUrl ?? "http://localhost:11434",
        model ?? "llama3",
      );
    default:
      throw new Error(`Unknown LLM provider: ${provider}`);
  }
}
