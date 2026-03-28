/**
 * Intent parser for the Bumble Bee Slack bot.
 * Uses LLM (Claude Haiku) for natural language understanding with regex fallback.
 */

export interface ParsedIntent {
  intent: "recall" | "meeting_notes" | "who_knows" | "action_items" | "briefing" | "summarize" | "join_meeting";
  query: string;
  dateHint?: string;
  person?: string;
  meetingUrl?: string;
}

// ── Regex patterns (fast fallback) ─────────────────────────────────────────

const MEETING_URL_PATTERN = /https?:\/\/(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)\/\S+/i;

const INTENT_PATTERNS: Array<{ intent: ParsedIntent["intent"]; pattern: RegExp }> = [
  { intent: "meeting_notes", pattern: /meeting\s*(?:notes?|minutes?|록)|회의\s*(?:록|노트)/i },
  { intent: "who_knows", pattern: /who\s*(?:knows?|is\s*(?:the\s*)?expert)|누가.*(?:알|전문)/i },
  { intent: "action_items", pattern: /action\s*items?|할\s*일|todo|tasks?|미완료|pending/i },
  { intent: "briefing", pattern: /briefing|브리핑|요약|summary|summarize|오늘|today/i },
];

const DATE_PATTERNS: RegExp[] = [
  /(\d{4}-\d{2}-\d{2})/,
  /(yesterday|today|this\s+week|last\s+week|오늘|어제|이번\s*주|지난\s*주)/i,
];

const PERSON_PATTERN = /(?:@(\w+)|(\w+)'s|(\w+)(?:의|가|이))/;

/**
 * Strip the bot mention token (`<@UXXXXX>`) from text.
 */
export function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/g, "").trim();
}

function extractDateHint(text: string): string | undefined {
  for (const p of DATE_PATTERNS) {
    const m = text.match(p);
    if (m) return m[1] ?? m[0];
  }
  return undefined;
}

function extractPerson(text: string): string | undefined {
  const m = text.match(PERSON_PATTERN);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? undefined;
}

/**
 * Parse with regex (fast, no API call).
 */
export function parseIntentRegex(rawText: string): ParsedIntent {
  const text = stripMention(rawText);
  const dateHint = extractDateHint(text);
  const person = extractPerson(text);
  const meetingUrlMatch = text.match(MEETING_URL_PATTERN);
  const meetingUrl = meetingUrlMatch?.[0];

  // If there's a meeting URL, it's a join request regardless of other keywords
  if (meetingUrl) {
    const query = text.replace(MEETING_URL_PATTERN, "").replace(/\s+/g, " ").trim();
    return { intent: "join_meeting", query, meetingUrl };
  }

  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      const query = text.replace(pattern, "").replace(/<@[A-Z0-9]+>/g, "").replace(/\s+/g, " ").trim();
      return { intent, query, dateHint, person };
    }
  }

  return { intent: "recall", query: text.replace(/\s+/g, " ").trim(), dateHint, person };
}

/**
 * Parse with LLM (Claude Haiku) for better understanding.
 * Falls back to regex if LLM is unavailable or fails.
 */
export async function parseIntent(rawText: string): Promise<ParsedIntent> {
  const text = stripMention(rawText);
  const apiKey = process.env.CORTEX_LLM_API_KEY ?? process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return parseIntentRegex(rawText);
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: `You are a Slack bot intent parser. Classify this message and extract search keywords.

Message: "${text}"

Respond ONLY with JSON:
{
  "intent": "recall" | "meeting_notes" | "who_knows" | "action_items" | "briefing" | "summarize" | "join_meeting",
  "query": "extracted search keywords (short, specific)",
  "person": "person name mentioned or null",
  "dateHint": "date reference or null",
  "meetingUrl": "meeting URL if present or null"
}

Intent guide:
- recall: searching for past decisions, discussions, information
- meeting_notes: looking for meeting records
- who_knows: asking who is expert/responsible for something
- action_items: looking for pending tasks/todos
- briefing: asking for a summary/overview of recent activity
- summarize: asking to summarize specific content or person's messages
- join_meeting: asking the bot to join/record a meeting (has a meeting URL or says "join")`,
        }],
      }),
    });

    if (!res.ok) {
      return parseIntentRegex(rawText);
    }

    const data = (await res.json()) as { content: Array<{ text: string }> };
    const responseText = data.content[0]?.text ?? "";
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return parseIntentRegex(rawText);

    const parsed = JSON.parse(jsonMatch[0]) as {
      intent?: string;
      query?: string;
      person?: string | null;
      dateHint?: string | null;
      meetingUrl?: string | null;
    };

    const validIntents = ["recall", "meeting_notes", "who_knows", "action_items", "briefing", "summarize", "join_meeting"];
    const intent = validIntents.includes(parsed.intent ?? "")
      ? (parsed.intent as ParsedIntent["intent"])
      : "recall";

    return {
      intent,
      query: parsed.query ?? text,
      person: parsed.person ?? undefined,
      dateHint: parsed.dateHint ?? undefined,
      meetingUrl: parsed.meetingUrl ?? undefined,
    };
  } catch {
    return parseIntentRegex(rawText);
  }
}
