import { createHash } from "node:crypto";
import type { HiveDatabase } from "../db/database.js";
import type { EnrichmentEngine } from "../enrichment/engine.js";
import { parseTranscript, parseTranscriptContent } from "./transcript-parser.js";
import type { ParsedTranscript } from "./transcript-parser.js";

export interface MeetingAgentOptions {
  transcriptPath?: string;
  transcriptContent?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  calendarEventId?: string;
}

export interface MeetingAgentResult {
  meetingEntityId: string;
  speakers: string[];
  decisionsCreated: number;
  actionsCreated: number;
  markdownOutput: string;
}

export class MeetingAgent {
  constructor(
    private db: HiveDatabase,
    private enrichmentEngine: EnrichmentEngine,
  ) {}

  async process(opts: MeetingAgentOptions): Promise<MeetingAgentResult> {
    // 1. Parse transcript
    let parsed: ParsedTranscript;
    if (opts.transcriptPath) {
      parsed = parseTranscript(opts.transcriptPath);
    } else if (opts.transcriptContent) {
      parsed = parseTranscriptContent(opts.transcriptContent);
    } else {
      throw new Error("Either transcriptPath or transcriptContent is required");
    }

    console.error(`[meeting] Parsed ${parsed.turns.length} turns, ${parsed.speakers.length} speakers (${parsed.format})`);

    // 2. Compute idempotency hash
    const hash = createHash("sha256")
      .update(parsed.plaintext)
      .digest("hex")
      .slice(0, 16);
    const externalId = `meeting:transcript:${hash}`;

    // 3. Check for existing meeting entity (idempotency)
    const existing = this.db.getByExternalId("meeting-agent", externalId);
    if (existing) {
      console.error(`[meeting] Already processed (entity: ${existing.id})`);
      // Re-render markdown from existing data
      const markdown = this.renderMarkdown(existing.id, parsed, opts);
      const decisions = this.db.listEntities({ entityType: "decision" }).filter(
        (e) => e.attributes?.extractedFrom === existing.id,
      );
      const actions = this.db.listEntities({ entityType: "task" }).filter(
        (e) => e.attributes?.extractedFrom === existing.id,
      );
      return {
        meetingEntityId: existing.id,
        speakers: parsed.speakers,
        decisionsCreated: decisions.length,
        actionsCreated: actions.length,
        markdownOutput: markdown,
      };
    }

    // 4. Create meeting entity
    const title = opts.title ?? `Meeting — ${opts.date ?? new Date().toISOString().split("T")[0]}`;
    const allSpeakers = [
      ...new Set([...parsed.speakers, ...(opts.attendees ?? [])]),
    ];

    const meetingEntityId = this.db.upsertEntity({
      entityType: "meeting",
      title,
      content: parsed.plaintext,
      tags: ["meeting", "transcript"],
      attributes: {
        date: opts.date ?? new Date().toISOString().split("T")[0],
        durationMinutes: parsed.durationMinutes,
        speakers: allSpeakers,
        transcriptFormat: parsed.format,
        transcriptHash: hash,
      },
      source: {
        system: "meeting-agent",
        externalId,
        connector: "meeting-agent",
      },
      domain: "meetings",
      confidence: "confirmed",
    });

    console.error(`[meeting] Created meeting entity: ${meetingEntityId}`);

    // 5. Create person entities for speakers
    for (const speaker of allSpeakers) {
      const normalizedId = speaker.toLowerCase().replace(/\s+/g, "-");
      const personExternalId = `meeting:speaker:${normalizedId}`;

      // Check if person already exists
      const existingPerson = this.db.getByExternalId(
        "meeting-agent",
        personExternalId,
      );
      const personId =
        existingPerson?.id ??
        this.db.upsertEntity({
          entityType: "person",
          title: speaker,
          content: speaker,
          tags: ["meeting-speaker"],
          attributes: { displayName: speaker },
          source: {
            system: "meeting-agent",
            externalId: personExternalId,
            connector: "meeting-agent",
          },
          domain: "meetings",
          confidence: "inferred",
        });

      // Create attended synapse
      this.db.upsertSynapse({
        sourceId: personId,
        targetId: meetingEntityId,
        axon: "attended",
        weight: 1.0,
      });
    }

    // 6. Run enrichment (ClassifyProvider + DecisionExtractorProvider)
    console.error("[meeting] Running enrichment pipeline...");
    await this.enrichmentEngine.enrichEntity(meetingEntityId);

    // 7. Count derived entities
    const allDecisions = this.db
      .listEntities({ entityType: "decision" })
      .filter((e) => e.attributes?.extractedFrom === meetingEntityId);
    const allActions = this.db
      .listEntities({ entityType: "task" })
      .filter((e) => e.attributes?.extractedFrom === meetingEntityId);

    console.error(
      `[meeting] Extracted ${allDecisions.length} decisions, ${allActions.length} action items`,
    );

    // 8. Link to calendar event if provided
    if (opts.calendarEventId) {
      const calEvent = this.db.getByExternalId(
        "google-calendar",
        opts.calendarEventId,
      );
      if (calEvent) {
        this.db.upsertSynapse({
          sourceId: meetingEntityId,
          targetId: calEvent.id,
          axon: "related",
          weight: 0.9,
        });
        console.error(`[meeting] Linked to calendar event: ${calEvent.id}`);
      } else {
        console.error(
          `[meeting] Calendar event not found: ${opts.calendarEventId}`,
        );
      }
    }

    // 9. Render markdown
    const markdownOutput = this.renderMarkdown(meetingEntityId, parsed, opts);

    return {
      meetingEntityId,
      speakers: allSpeakers,
      decisionsCreated: allDecisions.length,
      actionsCreated: allActions.length,
      markdownOutput,
    };
  }

  private renderMarkdown(
    meetingEntityId: string,
    parsed: ParsedTranscript,
    opts: MeetingAgentOptions,
  ): string {
    const entity = this.db.getEntity(meetingEntityId);
    const title = entity?.title ?? opts.title ?? "Meeting Notes";
    const date =
      (entity?.attributes?.date as string) ??
      opts.date ??
      new Date().toISOString().split("T")[0];
    const speakers = (entity?.attributes?.speakers as string[]) ?? parsed.speakers;
    const duration = parsed.durationMinutes;

    const decisions = this.db
      .listEntities({ entityType: "decision" })
      .filter((e) => e.attributes?.extractedFrom === meetingEntityId);
    const actions = this.db
      .listEntities({ entityType: "task" })
      .filter((e) => e.attributes?.extractedFrom === meetingEntityId);
    const keywords = entity?.keywords ?? [];

    const lines: string[] = [
      `# ${title}`,
      "",
      `**Date:** ${date}`,
      `**Attendees:** ${speakers.join(", ") || "Unknown"}`,
      ...(duration > 0 ? [`**Duration:** ${duration} minutes`] : []),
      "",
    ];

    // Summary (from enrichment)
    const summary = entity?.attributes?.summary as string | undefined;
    if (summary) {
      lines.push("## Summary", "", summary, "");
    }

    // Decisions
    lines.push("## Decisions", "");
    if (decisions.length > 0) {
      for (const d of decisions) {
        lines.push(`- ${d.title ?? d.content.slice(0, 100)}`);
      }
    } else {
      lines.push("None identified.");
    }
    lines.push("");

    // Action Items
    lines.push("## Action Items", "");
    if (actions.length > 0) {
      for (const a of actions) {
        const owner = (a.attributes?.owner as string) ?? "unassigned";
        const deadline = (a.attributes?.deadline as string) ?? "";
        const suffix = deadline ? ` (by ${deadline})` : "";
        lines.push(`- [ ] ${a.title ?? a.content.slice(0, 100)} — ${owner}${suffix}`);
      }
    } else {
      lines.push("None identified.");
    }
    lines.push("");

    // Topics
    if (keywords.length > 0) {
      lines.push("## Topics", "");
      lines.push(keywords.map((k) => `\`${k}\``).join(", "));
      lines.push("");
    }

    return lines.join("\n");
  }
}
