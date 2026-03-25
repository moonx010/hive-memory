import { createHash } from "node:crypto";
import type { HiveDatabase } from "../db/database.js";
import type { EnrichmentEngine } from "../enrichment/engine.js";
import { parseTranscript, parseTranscriptContent } from "./transcript-parser.js";
import type { ParsedTranscript } from "./transcript-parser.js";
import { postToSlack, postToNotion } from "./output.js";

export interface MeetingAgentOptions {
  transcriptPath?: string;
  transcriptContent?: string;
  title?: string;
  date?: string;
  attendees?: string[];
  calendarEventId?: string;
  slackWebhook?: string;
  notionParentPageId?: string;
}

export interface PreBriefingOptions {
  title: string;
  attendees: string[];
  topics?: string[];
}

export interface PreBriefingResult {
  markdownOutput: string;
  attendeeActivity: Array<{
    name: string;
    recentDecisions: number;
    recentActions: number;
  }>;
  relatedDecisions: number;
  pendingActions: number;
}

export interface MeetingAgentResult {
  meetingEntityId: string;
  speakers: string[];
  decisionsCreated: number;
  actionsCreated: number;
  markdownOutput: string;
  slackPosted?: boolean;
  notionPageUrl?: string;
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
      const existingTitle = existing.title ?? opts.title ?? "Meeting Notes";
      const existingSharing = await this.shareOutput(markdown, existingTitle, opts);
      return {
        meetingEntityId: existing.id,
        speakers: parsed.speakers,
        decisionsCreated: decisions.length,
        actionsCreated: actions.length,
        markdownOutput: markdown,
        ...existingSharing,
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

    // 10. Optional output sharing
    const sharing = await this.shareOutput(markdownOutput, title, opts);

    return {
      meetingEntityId,
      speakers: allSpeakers,
      decisionsCreated: allDecisions.length,
      actionsCreated: allActions.length,
      markdownOutput,
      ...sharing,
    };
  }

  private async shareOutput(
    markdown: string,
    title: string,
    opts: MeetingAgentOptions,
  ): Promise<{ slackPosted?: boolean; notionPageUrl?: string }> {
    const result: { slackPosted?: boolean; notionPageUrl?: string } = {};

    if (opts.slackWebhook) {
      try {
        await postToSlack({ webhookUrl: opts.slackWebhook, markdown });
        result.slackPosted = true;
      } catch (err) {
        console.error("[meeting] Slack posting failed:", err);
        result.slackPosted = false;
      }
    }

    if (opts.notionParentPageId) {
      const notionToken = process.env.NOTION_TOKEN;
      if (!notionToken) {
        console.error("[meeting] NOTION_TOKEN not set, skipping Notion post");
      } else {
        try {
          result.notionPageUrl = await postToNotion({
            token: notionToken,
            parentPageId: opts.notionParentPageId,
            title,
            markdown,
          });
        } catch (err) {
          console.error("[meeting] Notion posting failed:", err);
        }
      }
    }

    return result;
  }

  /**
   * Generate a pre-meeting briefing based on attendees and topics.
   * Looks up attendee activity, related decisions, and pending action items.
   */
  async generateBriefing(opts: PreBriefingOptions): Promise<PreBriefingResult> {
    const lines: string[] = [
      `# Pre-Meeting Briefing: ${opts.title}`,
      "",
      `**Attendees:** ${opts.attendees.join(", ")}`,
      "",
    ];

    // 1. Attendee activity — find person entities and their recent involvement
    const attendeeActivity: PreBriefingResult["attendeeActivity"] = [];

    for (const name of opts.attendees) {
      const normalized = name.toLowerCase().trim();
      const persons = this.db.findPersonsByNormalizedName(normalized);

      let recentDecisions = 0;
      let recentActions = 0;

      for (const person of persons) {
        // Find meetings this person attended
        const synapses = this.db.getSynapsesByEntry(person.id, "outgoing", "attended");
        for (const syn of synapses) {
          // Count decisions/actions derived from those meetings
          const decisions = this.db.listEntities({ entityType: "decision" })
            .filter((e) => e.attributes?.extractedFrom === syn.target);
          const actions = this.db.listEntities({ entityType: "task" })
            .filter((e) => e.attributes?.extractedFrom === syn.target);
          recentDecisions += decisions.length;
          recentActions += actions.length;
        }
      }

      attendeeActivity.push({ name, recentDecisions, recentActions });
    }

    // 2. Attendee summary
    lines.push("## Attendee Context", "");
    for (const a of attendeeActivity) {
      if (a.recentDecisions > 0 || a.recentActions > 0) {
        lines.push(`- **${a.name}**: ${a.recentDecisions} recent decisions, ${a.recentActions} action items`);
      } else {
        lines.push(`- **${a.name}**: No recent activity in memory`);
      }
    }
    lines.push("");

    // 3. Topic-related decisions
    const topicQueries = opts.topics ?? [opts.title];
    const relatedDecisions: Array<{ title: string; content: string }> = [];

    for (const topic of topicQueries) {
      const results = this.db.searchEntities(topic, {
        entityType: "decision",
        limit: 5,
      });
      for (const r of results) {
        if (!relatedDecisions.find((d) => d.title === r.title)) {
          relatedDecisions.push({
            title: r.title ?? r.content.slice(0, 80),
            content: r.content.slice(0, 200),
          });
        }
      }
    }

    lines.push("## Related Decisions", "");
    if (relatedDecisions.length > 0) {
      for (const d of relatedDecisions.slice(0, 10)) {
        lines.push(`- ${d.title}`);
      }
    } else {
      lines.push("No related decisions found.");
    }
    lines.push("");

    // 4. Pending action items
    const pendingActions = this.db
      .listEntities({ entityType: "task", limit: 20 })
      .filter((e) => e.attributes?.actionStatus === "open");

    lines.push("## Pending Action Items", "");
    if (pendingActions.length > 0) {
      for (const a of pendingActions.slice(0, 10)) {
        const owner = (a.attributes?.owner as string) ?? "unassigned";
        lines.push(`- [ ] ${a.title ?? a.content.slice(0, 80)} — ${owner}`);
      }
    } else {
      lines.push("No pending action items.");
    }
    lines.push("");

    return {
      markdownOutput: lines.join("\n"),
      attendeeActivity,
      relatedDecisions: relatedDecisions.length,
      pendingActions: pendingActions.length,
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
