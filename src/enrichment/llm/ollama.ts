import type { LLMProvider } from "../types.js";
import { LLMError } from "./openai.js";

function parseJson<T>(text: string): T {
  const jsonMatch =
    text.match(/```json\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*\})/);
  return JSON.parse(jsonMatch?.[1] ?? text) as T;
}

export class OllamaProvider implements LLMProvider {
  readonly model: string;
  constructor(
    private baseUrl = "http://localhost:11434",
    model = "llama3",
  ) {
    this.model = model;
  }

  async complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const options: Record<string, unknown> = {};
    if (opts?.temperature !== undefined) options.temperature = opts.temperature;
    if (opts?.maxTokens !== undefined) options.num_predict = opts.maxTokens;

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        ...(Object.keys(options).length > 0 && { options }),
      }),
    });
    if (!res.ok) throw new LLMError(res.status, await res.text());
    const data = (await res.json()) as {
      message: { content: string };
    };
    return data.message.content ?? "";
  }

  async extract<T>(
    prompt: string,
    schema: Record<string, unknown>,
  ): Promise<T> {
    const fullPrompt = `${prompt}\n\nRespond ONLY with valid JSON matching this schema:\n${JSON.stringify(schema, null, 2)}`;
    const text = await this.complete(fullPrompt);
    return parseJson<T>(text);
  }
}
