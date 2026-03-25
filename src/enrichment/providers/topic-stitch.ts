import type { HiveDatabase } from "../../db/database.js";
import type { Entity, LLMProvider } from "../types.js";

export interface StitchResult {
  candidates: number;
  pairs: number;
  linked: number;
}

function computeJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.slice(0, 5));
  const setB = new Set(b.slice(0, 5));
  const intersection = [...setA].filter((k) => setB.has(k)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export class TopicStitcher {
  constructor(
    private db: HiveDatabase,
    private llm?: LLMProvider,
  ) {}

  async stitchBatch(
    opts: { limit?: number; minJaccard?: number } = {},
  ): Promise<StitchResult> {
    const minJaccard = opts.minJaccard ?? 0.4;
    const limit = Math.min(opts.limit ?? 500, 1000);

    // Load entities with keywords
    const candidates = this.db.listEntities({
      hasKeywords: true,
      limit,
    });

    // Compute pairwise Jaccard on top-5 keywords
    const pairs: [Entity, Entity, number][] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const jaccard = computeJaccard(
          candidates[i].keywords,
          candidates[j].keywords,
        );
        if (jaccard >= minJaccard) {
          pairs.push([candidates[i], candidates[j], jaccard]);
        }
      }
    }

    // Create synapses for qualifying pairs
    let linked = 0;
    for (const [a, b, score] of pairs) {
      let finalScore = score;

      // Optional LLM confirmation for borderline pairs
      if (this.llm && score < 0.7) {
        try {
          finalScore = await this.confirmWithLLM(a, b);
          if (finalScore < 0.5) continue;
        } catch {
          // Fallback to keyword score on LLM failure
          finalScore = score;
        }
      }

      this.db.upsertSynapse({
        sourceId: a.id,
        targetId: b.id,
        axon: "related",
        weight: finalScore,
      });
      linked++;
    }

    return { candidates: candidates.length, pairs: pairs.length, linked };
  }

  private async confirmWithLLM(a: Entity, b: Entity): Promise<number> {
    if (!this.llm) return 0;

    const prompt = `Are these two items semantically related? Score from 0.0 to 1.0.

Item A: ${a.title ?? ""} — ${a.content.slice(0, 200)}
Item B: ${b.title ?? ""} — ${b.content.slice(0, 200)}`;

    const result = await this.llm.extract<{ score: number }>(prompt, {
      type: "object",
      properties: { score: { type: "number", minimum: 0, maximum: 1 } },
      required: ["score"],
    });

    return result.score;
  }
}
