/**
 * Intent parser for the Bumble Bee Slack bot.
 * Regex-based, no LLM required. Classifies user mentions into one of four intents.
 */

export interface ParsedIntent {
  intent: "recall" | "meeting_notes" | "who_knows" | "action_items";
  query: string;
  dateHint?: string;
}

// Ordered: first match wins. recall is the fallback — no pattern needed.
const INTENT_PATTERNS: Array<{ intent: ParsedIntent["intent"]; pattern: RegExp }> = [
  {
    intent: "meeting_notes",
    pattern: /meeting\s*(?:notes?|minutes?|록)|회의\s*(?:록|노트)/i,
  },
  {
    intent: "who_knows",
    pattern: /who\s*(?:knows?|is\s*(?:the\s*)?expert)|누가.*(?:알|전문)/i,
  },
  {
    intent: "action_items",
    pattern: /action\s*items?|할\s*일|todo|tasks?|미완료/i,
  },
];

// Date patterns extracted from text
const DATE_PATTERNS: RegExp[] = [
  /(\d{4}-\d{2}-\d{2})/,
  /(yesterday|today|this\s+week|last\s+week)/i,
  /(last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i,
];

// Keywords to strip when extracting query for each intent
const INTENT_KEYWORDS: Record<ParsedIntent["intent"], RegExp> = {
  meeting_notes: /meeting\s*(?:notes?|minutes?|록)|회의\s*(?:록|노트)/gi,
  who_knows: /who\s*(?:knows?|is\s*(?:the\s*)?expert)|누가.*(?:알|전문)/gi,
  action_items: /action\s*items?|할\s*일|todo|tasks?|미완료/gi,
  recall: /(?:what\s+did\s+we\s+(?:decide|discuss)\s+(?:about)?|결정|decision\s+(?:about)?|find|search|찾아|알려줘)/gi,
};

/**
 * Strip the bot mention token (`<@UXXXXX>`) from text.
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

/**
 * Extract a date hint from the text. Returns the first match found.
 */
function extractDateHint(text: string): string | undefined {
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return undefined;
}

/**
 * Parse user text (with mention already stripped) into a structured intent.
 */
export function parseIntent(rawText: string): ParsedIntent {
  const text = stripMention(rawText);
  const dateHint = extractDateHint(text);

  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      // Strip intent keywords and date references to get the query
      const query = text
        .replace(INTENT_KEYWORDS[intent], "")
        .replace(/\d{4}-\d{2}-\d{2}/g, "")
        .replace(/\b(?:yesterday|today|this\s+week|last\s+week|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi, "")
        .replace(/\s+/g, " ")
        .trim();

      return { intent, query, ...(dateHint ? { dateHint } : {}) };
    }
  }

  // Default: recall
  const query = text
    .replace(INTENT_KEYWORDS.recall, "")
    .replace(/\s+/g, " ")
    .trim();

  return { intent: "recall", query, ...(dateHint ? { dateHint } : {}) };
}
