import type { HiveDatabase, EntityAlias } from "../db/database.js";
import type { Entity } from "../types.js";
import type { LLMProvider } from "./types.js";

export interface ResolutionCandidate {
  entity: Entity;
  matchType: "exact_email" | "exact_name" | "handle" | "llm_fuzzy";
  confidence: "confirmed" | "inferred";
}

export interface MergeResult {
  primaryId: string;
  supersededId: string;
  synapsesMoved: number;
  aliasesCreated: number;
}

export class EntityResolver {
  constructor(private db: HiveDatabase) {}

  findCandidates(entity: Entity): ResolutionCandidate[] {
    if (entity.entityType !== "person") return [];

    const candidates: ResolutionCandidate[] = [];
    const seen = new Set<string>();
    seen.add(entity.id); // Exclude self

    // 1. Exact email match
    const email = entity.attributes?.email as string | undefined;
    if (email) {
      const matches = this.db.findPersonsByEmail(email, entity.source.system);
      for (const m of matches) {
        if (!seen.has(m.id)) {
          candidates.push({
            entity: m,
            matchType: "exact_email",
            confidence: "confirmed",
          });
          seen.add(m.id);
        }
      }
    }

    // 2. Exact normalized name match
    const normalizedTitle = entity.title?.toLowerCase().trim() ?? "";
    if (normalizedTitle.length >= 3) {
      const nameMatches = this.db.findPersonsByNormalizedName(
        normalizedTitle,
        entity.source.system,
      );
      for (const m of nameMatches) {
        if (!seen.has(m.id)) {
          candidates.push({
            entity: m,
            matchType: "exact_name",
            confidence: "confirmed",
          });
          seen.add(m.id);
        }
      }
    }

    // 3. Handle/username match
    const handle =
      (entity.attributes?.handle as string | undefined) ??
      (entity.attributes?.username as string | undefined);
    if (handle) {
      const handleMatches = this.db.findPersonsByHandle(
        handle,
        entity.source.system,
      );
      for (const m of handleMatches) {
        if (!seen.has(m.id)) {
          candidates.push({
            entity: m,
            matchType: "handle",
            confidence: "inferred",
          });
          seen.add(m.id);
        }
      }
    }

    return candidates.slice(0, 10);
  }

  async resolveWithLLM(
    a: Entity,
    b: Entity,
    llm: LLMProvider,
  ): Promise<boolean> {
    const distance = levenshtein(a.title ?? "", b.title ?? "");
    if (distance === 0) return true;
    if (distance > 3) return false;

    const prompt = `Are these two person profiles the same individual?

Person A:
- Name: ${a.title}
- Email: ${(a.attributes?.email as string) ?? "unknown"}
- Source: ${a.source.system}

Person B:
- Name: ${b.title}
- Email: ${(b.attributes?.email as string) ?? "unknown"}
- Source: ${b.source.system}

Answer with JSON: { "same_person": true/false, "reasoning": "one sentence" }`;

    const result = await llm.extract<{
      same_person: boolean;
      reasoning: string;
    }>(prompt, {
      type: "object",
      properties: {
        same_person: { type: "boolean" },
        reasoning: { type: "string" },
      },
      required: ["same_person"],
    });

    return result.same_person;
  }

  merge(primaryId: string, supersededId: string): MergeResult {
    const result = this.db.mergeEntities(primaryId, supersededId);
    console.error(
      `[entity-resolver] merged ${supersededId} → ${primaryId} ` +
        `(${result.synapsesMoved} synapses, ${result.aliasesCreated} aliases)`,
    );
    return { primaryId, supersededId, ...result };
  }

  getAliases(entityId: string): EntityAlias[] {
    return this.db.getAliases(entityId);
  }
}

/** Compute Levenshtein distance between two strings. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
