import type {
  Entity,
  EnrichmentContext,
  EnrichmentProvider,
  EnrichmentResult,
  EntityType,
} from "../types.js";

const CODE_PATTERNS = [
  /\bfunction\b/,
  /\bclass\b/,
  /\bimport\b/,
  /\bconst\s+\w+\s*=/,
  /=>/,
  /\binterface\b/,
  /\btype\b.*=/,
  /\bexport\b/,
];

const MEETING_PATTERNS = [
  /\battendee(s)?\b/i,
  /\bagenda\b/i,
  /\bminutes\b/i,
  /\bstandup\b/i,
  /\bsync\b/i,
  /\baction items\b/i,
];

const DECISION_PATTERNS = [
  /\bdecided\b/i,
  /\bapproved\b/i,
  /\bresolved\b/i,
  /\bagreed\b/i,
];

const TIME_SENSITIVE_PATTERNS = [
  /\bdeadline\b/i,
  /\bdue by\b/i,
  /\bdue date\b/i,
  /\bby eod\b/i,
  /\bby eow\b/i,
  /\bby (monday|tuesday|wednesday|thursday|friday)\b/i,
];

export class ClassifyProvider implements EnrichmentProvider {
  readonly id = "classify";
  readonly name = "Rule-Based Classifier";
  readonly applicableTo: ["*"] = ["*"];
  readonly priority = 100;

  shouldEnrich(entity: Entity): boolean {
    return entity.content.length >= 20;
  }

  async enrich(
    entity: Entity,
    _ctx: EnrichmentContext,
  ): Promise<EnrichmentResult> {
    const content = entity.content;
    const tags: string[] = [];
    const attributes: Record<string, unknown> = {};

    // Domain detection
    if (CODE_PATTERNS.some((p) => p.test(content))) {
      attributes.domain = "code";
    } else if (MEETING_PATTERNS.some((p) => p.test(content))) {
      attributes.domain = "meetings";
    }

    // Signal strength
    const reactions = Number(entity.attributes?.reactions ?? 0);
    const replies = Number(
      entity.attributes?.replyCount ??
        entity.attributes?.commentCount ??
        0,
    );
    if (reactions >= 5 || replies >= 10) tags.push("high-signal");

    // Time sensitivity
    if (TIME_SENSITIVE_PATTERNS.some((p) => p.test(content)))
      tags.push("time-sensitive");

    // Decision marker
    if (DECISION_PATTERNS.some((p) => p.test(content))) tags.push("decision");

    return { attributes, tags };
  }
}
