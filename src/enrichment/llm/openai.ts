import type { LLMProvider } from "../types.js";

export class LLMError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`LLM error (${status}): ${message}`);
    this.name = "LLMError";
  }
}

function parseJson<T>(text: string): T {
  const jsonMatch =
    text.match(/```json\n?([\s\S]*?)\n?```/) ?? text.match(/(\{[\s\S]*\})/);
  return JSON.parse(jsonMatch?.[1] ?? text) as T;
}

export class OpenAIProvider implements LLMProvider {
  readonly model: string;
  constructor(
    private apiKey: string,
    model = "gpt-4o-mini",
  ) {
    this.model = model;
  }

  async complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: opts?.maxTokens ?? 500,
        temperature: opts?.temperature ?? 0.3,
      }),
    });
    if (!res.ok) throw new LLMError(res.status, await res.text());
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    return data.choices[0].message.content ?? "";
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
