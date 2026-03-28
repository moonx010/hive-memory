export interface RewrittenQuery {
  original: string;
  rewritten: string;
  expandedTerms: string[];
  intent: "factual" | "exploratory" | "temporal" | "person" | "decision";
}

/**
 * Rewrite user query for better retrieval.
 * - Expand acronyms and abbreviations
 * - Add synonyms
 * - Classify intent
 * - Handle enterprise jargon
 */
export async function rewriteQuery(query: string): Promise<RewrittenQuery> {
  const llmProvider = process.env.CORTEX_LLM_PROVIDER;

  if (!llmProvider || llmProvider === "none" || process.env.CORTEX_ENRICHMENT === "off") {
    // Fallback: simple rule-based expansion
    return ruleBasedRewrite(query);
  }

  // LLM rewrite using Claude Haiku (cheapest)
  return llmRewrite(query);
}

export function ruleBasedRewrite(query: string): RewrittenQuery {
  const expandedTerms: string[] = [];

  // Common tech abbreviations
  const expansions: Record<string, string> = {
    "DB": "database",
    "API": "API interface endpoint",
    "PR": "pull request",
    "CI": "continuous integration",
    "CD": "continuous deployment",
    "k8s": "kubernetes",
    "FE": "frontend",
    "BE": "backend",
    "auth": "authentication authorization",
    "perf": "performance",
    "infra": "infrastructure",
  };

  for (const [abbr, expansion] of Object.entries(expansions)) {
    if (new RegExp(`\\b${abbr}\\b`, "i").test(query)) {
      expandedTerms.push(expansion);
    }
  }

  let rewritten = query;
  if (expandedTerms.length > 0) {
    rewritten = `${query} ${expandedTerms.join(" ")}`;
  }

  // Intent classification
  const intent = classifyIntent(query);

  return { original: query, rewritten, expandedTerms, intent };
}

export function classifyIntent(query: string): RewrittenQuery["intent"] {
  // Check decision/person/temporal BEFORE factual — more specific patterns first
  if (/\bdecid(e|ed)\b|결정|decision|approved|agreed/.test(query)) return "decision";
  if (/who|누가|person|author/.test(query)) return "person";
  if (/when|언제|last|recent|history/.test(query)) return "temporal";
  if (/what|how|why|explain/.test(query)) return "factual";
  return "exploratory";
}

async function llmRewrite(query: string): Promise<RewrittenQuery> {
  // Use the LLM factory from enrichment
  const { createLLMProvider } = await import("../enrichment/llm/index.js");
  const llm = createLLMProvider();
  if (!llm) return ruleBasedRewrite(query);

  try {
    const result = await llm.extract<{ rewritten: string; terms: string[]; intent: string }>(
      `Rewrite this search query for better information retrieval. Expand abbreviations, add synonyms, classify intent.
Query: "${query}"`,
      {
        type: "object",
        properties: {
          rewritten: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
          intent: { type: "string", enum: ["factual", "exploratory", "temporal", "person", "decision"] },
        },
        required: ["rewritten", "terms", "intent"],
      },
    );
    return {
      original: query,
      rewritten: result.rewritten,
      expandedTerms: result.terms,
      intent: result.intent as RewrittenQuery["intent"],
    };
  } catch {
    return ruleBasedRewrite(query);
  }
}
