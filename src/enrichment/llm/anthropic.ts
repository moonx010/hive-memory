import type { LLMProvider } from "../types.js";
import { LLMError } from "./openai.js";

function parseJson<T>(text: string): T {
  const jsonMatch =
    text.match(/```json\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*\})/);
  return JSON.parse(jsonMatch?.[1] ?? text) as T;
}

export class AnthropicProvider implements LLMProvider {
  readonly model: string;
  constructor(
    private apiKey: string,
    model = "claude-haiku-4-5",
  ) {
    this.model = model;
  }

  async complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts?.maxTokens ?? 500,
        temperature: opts?.temperature ?? 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) throw new LLMError(res.status, await res.text());
    const data = (await res.json()) as {
      content: { type: string; text: string }[];
    };
    return data.content[0]?.text ?? "";
  }

  async extract<T>(
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
    const fullPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
    const text = await this.complete(fullPrompt, {
      maxTokens: 1000,
      temperature: 0,
    });
    return parseJson<T>(text);
  }
}
