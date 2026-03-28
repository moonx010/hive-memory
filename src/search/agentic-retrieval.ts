import type { Entity } from "../types.js";
import type { HiveDatabase, SearchEntitiesOptions } from "../db/database.js";
import type { ACLContext } from "../acl/types.js";
import { rewriteQuery } from "./query-rewriter.js";
import type { RewrittenQuery } from "./query-rewriter.js";

export interface RetrievalStep {
  query: string;
  results: Entity[];
  reasoning: string;
}

export interface AgenticRetrievalResult {
  steps: RetrievalStep[];
  finalResults: Entity[];
  synthesizedAnswer?: string;
}

/**
 * Multi-step retrieval: decompose complex queries into sub-queries,
 * execute sequentially, and synthesize results.
 *
 * Inspired by Perplexity Deep Research.
 */
export async function agenticRetrieve(
  query: string,
  db: HiveDatabase,
  options?: { maxSteps?: number; acl?: ACLContext },
): Promise<AgenticRetrievalResult> {
  const maxSteps = options?.maxSteps ?? 3;

  // Step 1: Classify if agentic retrieval is needed
  const rewritten = await rewriteQuery(query);

  // Simple queries don't need multi-step
  if (rewritten.intent === "factual" && query.split(" ").length < 8) {
    const searchOptions: SearchEntitiesOptions = {
      limit: 20,
      ...(options?.acl ? { acl: options.acl } : {}),
    };
    const results = db.searchEntities(rewritten.rewritten, searchOptions);
    return {
      steps: [{ query: rewritten.rewritten, results, reasoning: "Direct retrieval" }],
      finalResults: results,
    };
  }

  // Step 2: Decompose into sub-queries
  const subQueries = decomposeQuery(query, rewritten);

  // Step 3: Execute each sub-query
  const steps: RetrievalStep[] = [];
  const allResults = new Map<string, Entity>();

  for (const sq of subQueries.slice(0, maxSteps)) {
    const searchOptions: SearchEntitiesOptions = {
      limit: 10,
      ...(options?.acl ? { acl: options.acl } : {}),
    };
    const results = db.searchEntities(sq, searchOptions);
    steps.push({ query: sq, results, reasoning: `Sub-query ${steps.length + 1}` });
    for (const r of results) allResults.set(r.id, r);
  }

  // Step 4: Deduplicate and rank by frequency across steps
  const scoredResults = [...allResults.entries()]
    .map(([id, entity]) => ({
      entity,
      score: steps.filter(s => s.results.some(r => r.id === id)).length,
    }))
    .sort((a, b) => b.score - a.score);

  return {
    steps,
    finalResults: scoredResults.slice(0, 20).map(r => r.entity),
  };
}

export function decomposeQuery(query: string, rewritten: RewrittenQuery): string[] {
  const queries = [rewritten.rewritten];

  // Add intent-specific sub-queries
  switch (rewritten.intent) {
    case "decision":
      queries.push(`${query} alternatives considered`);
      queries.push(`${query} rationale reasoning why`);
      break;
    case "temporal":
      queries.push(`${query} timeline history`);
      queries.push(`${query} latest recent update`);
      break;
    case "person":
      queries.push(`${query} contributions decisions`);
      queries.push(`${query} meetings attended`);
      break;
    case "exploratory":
      queries.push(`${query} related topics`);
      queries.push(`${query} examples implementations`);
      break;
    default:
      // factual: no additional sub-queries needed beyond the rewritten one
      break;
  }

  return queries;
}
