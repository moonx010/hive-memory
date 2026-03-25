import type {
  Entity,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
} from "../types.js";

const RETRY_MAX = 3;
const RETRY_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LLMEnrichProvider implements EnrichmentProvider {
  readonly id = "llm-enrich";
  readonly name = "LLM Enricher";
  readonly applicableTo: ["*"] = ["*"];
  readonly priority = 200;

  shouldEnrich(entity: Entity): boolean {
    return entity.content.length >= 100;
  }

  async enrich(
    entity: Entity,
    ctx: EnrichmentContext,
  ): Promise<EnrichmentResult> {
    if (!ctx.llm) return {};

    const attributes: Record<string, unknown> = {};

    const prompt = `Analyze this content and extract:
1. A one-line summary (max 100 characters)
2. The domain category (one of: code, documents, conversations, meetings, incidents, product, operations, or null if unclear)

Content:
${entity.content.slice(0, 2000)}`;

    const schema = {
      type: "object",
      properties: {
        summary: { type: "string", maxLength: 100 },
        domain: {
          type: ["string", "null"],
          enum: [
            "code",
            "documents",
            "conversations",
            "meetings",
            "incidents",
            "product",
            "operations",
            null,
          ],
        },
      },
      required: ["summary", "domain"],
    };

    let lastError: unknown;
    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        const result = await ctx.llm.extract<{
          summary: string;
          domain: string | null;
        }>(prompt, schema);
        attributes.summary = result.summary.slice(0, 100);
        if (result.domain && (!entity.attributes?.domain || entity.attributes.domain === "unknown")) {
          attributes.domain = result.domain;
        }
        attributes._llmModel = ctx.llm.model;
        return { attributes };
      } catch (err: unknown) {
        lastError = err;
        if (
          err &&
          typeof err === "object" &&
          "status" in err &&
          (err as { status: number }).status === 429 &&
          attempt < RETRY_MAX
        ) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    attributes._llmError = String(lastError);
    return { attributes };
  }
}
