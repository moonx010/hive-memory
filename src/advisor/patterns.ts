import type { HiveDatabase } from "../db/database.js";
import type { ACLContext } from "../acl/types.js";

export interface ActivityPattern {
  /** Hour distribution of entity creation (0-23 → count) */
  hourlyDistribution: Record<number, number>;
  /** Day-of-week distribution (0=Sun, 6=Sat → count) */
  dailyDistribution: Record<number, number>;
  /** Most active project by entity count */
  topProjects: Array<{ project: string; count: number }>;
  /** Domain distribution */
  domainDistribution: Record<string, number>;
  /** Entity type distribution */
  typeDistribution: Record<string, number>;
}

export interface CollaborationGraph {
  /** Pairs of people who frequently co-attend meetings */
  edges: Array<{
    personA: string;
    personB: string;
    sharedMeetings: number;
  }>;
  /** People with most connections */
  hubs: Array<{ name: string; connections: number }>;
}

export interface PatternReport {
  period: { from: string; to: string };
  activity: ActivityPattern;
  collaboration: CollaborationGraph;
  markdownOutput: string;
}

export class PatternAnalyzer {
  private acl?: ACLContext;
  constructor(private db: HiveDatabase, acl?: ACLContext) {
    this.acl = acl;
  }

  analyze(opts?: { since?: string; project?: string }): PatternReport {
    const since =
      opts?.since ??
      new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();

    // Fetch entities in period
    const entities = this.db.listEntities({
      since,
      project: opts?.project,
      limit: 5000,
      sort: "created_at",
      acl: this.acl,
    });

    // 1. Hourly distribution (by createdAt)
    const hourlyDistribution: Record<number, number> = {};
    for (let h = 0; h < 24; h++) hourlyDistribution[h] = 0;

    // 2. Daily distribution
    const dailyDistribution: Record<number, number> = {};
    for (let d = 0; d < 7; d++) dailyDistribution[d] = 0;

    // 3. Project counts
    const projectCounts = new Map<string, number>();

    // 4. Domain distribution
    const domainDistribution: Record<string, number> = {};

    // 5. Type distribution
    const typeDistribution: Record<string, number> = {};

    for (const entity of entities) {
      const date = new Date(entity.createdAt);
      hourlyDistribution[date.getUTCHours()] =
        (hourlyDistribution[date.getUTCHours()] ?? 0) + 1;
      dailyDistribution[date.getUTCDay()] =
        (dailyDistribution[date.getUTCDay()] ?? 0) + 1;

      if (entity.project) {
        projectCounts.set(
          entity.project,
          (projectCounts.get(entity.project) ?? 0) + 1,
        );
      }

      domainDistribution[entity.domain] =
        (domainDistribution[entity.domain] ?? 0) + 1;

      typeDistribution[entity.entityType] =
        (typeDistribution[entity.entityType] ?? 0) + 1;
    }

    const topProjects = [...projectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([project, count]) => ({ project, count }));

    // 6. Collaboration graph
    // Find all meetings, then find persons who attended each meeting
    const meetings = this.db.listEntities({
      entityType: "meeting",
      since,
      project: opts?.project,
      limit: 1000,
      acl: this.acl,
    });

    // Map: meetingId → list of attendee names
    const meetingAttendees = new Map<string, string[]>();

    for (const meeting of meetings) {
      const synapses = this.db.getSynapsesByEntry(
        meeting.id,
        "incoming",
        "attended",
      );
      const attendees: string[] = [];
      for (const synapse of synapses) {
        const person = this.db.getEntity(synapse.source, this.acl);
        if (person && person.entityType === "person" && person.title) {
          attendees.push(person.title);
        }
      }
      if (attendees.length >= 2) {
        meetingAttendees.set(meeting.id, attendees);
      }
    }

    // Build edge counts: "personA:personB" → sharedMeetings
    const edgeCounts = new Map<string, number>();

    for (const attendees of meetingAttendees.values()) {
      for (let i = 0; i < attendees.length; i++) {
        for (let j = i + 1; j < attendees.length; j++) {
          const a = attendees[i] < attendees[j] ? attendees[i] : attendees[j];
          const b = attendees[i] < attendees[j] ? attendees[j] : attendees[i];
          const key = `${a}|||${b}`;
          edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }
      }
    }

    // Only include pairs who share 2+ meetings
    const edges: CollaborationGraph["edges"] = [];
    for (const [key, count] of edgeCounts.entries()) {
      if (count >= 2) {
        const [personA, personB] = key.split("|||");
        edges.push({ personA, personB, sharedMeetings: count });
      }
    }
    edges.sort((a, b) => b.sharedMeetings - a.sharedMeetings);

    // Hubs: count unique collaboration partners per person
    const connectionCounts = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!connectionCounts.has(edge.personA))
        connectionCounts.set(edge.personA, new Set());
      if (!connectionCounts.has(edge.personB))
        connectionCounts.set(edge.personB, new Set());
      connectionCounts.get(edge.personA)!.add(edge.personB);
      connectionCounts.get(edge.personB)!.add(edge.personA);
    }

    const hubs: CollaborationGraph["hubs"] = [...connectionCounts.entries()]
      .map(([name, partners]) => ({ name, connections: partners.size }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 10);

    const activity: ActivityPattern = {
      hourlyDistribution,
      dailyDistribution,
      topProjects,
      domainDistribution,
      typeDistribution,
    };

    const collaboration: CollaborationGraph = { edges, hubs };

    const markdownOutput = this.renderMarkdown(since, to, activity, collaboration);

    return {
      period: { from: since, to },
      activity,
      collaboration,
      markdownOutput,
    };
  }

  private renderMarkdown(
    from: string,
    to: string,
    activity: ActivityPattern,
    collaboration: CollaborationGraph,
  ): string {
    const lines: string[] = [
      "# Working Pattern Analysis",
      "",
      `**Period:** ${from.split("T")[0]} — ${to.split("T")[0]}`,
      "",
    ];

    // Activity heatmap — hourly distribution (text-based)
    lines.push("## Activity Heatmap (by hour, UTC)", "");
    const maxHourCount = Math.max(...Object.values(activity.hourlyDistribution), 1);
    const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

    const barLine: string[] = [];
    const labelLine: string[] = [];
    for (let h = 0; h < 24; h++) {
      const count = activity.hourlyDistribution[h] ?? 0;
      const level = Math.floor((count / maxHourCount) * (blocks.length - 1));
      barLine.push(blocks[level]);
      labelLine.push(h.toString().padStart(2, "0"));
    }
    lines.push("```");
    lines.push(barLine.join(" "));
    lines.push(labelLine.join(" "));
    lines.push("```", "");

    // Day-of-week distribution
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    lines.push("## Activity by Day of Week", "");
    const maxDayCount = Math.max(...Object.values(activity.dailyDistribution), 1);
    lines.push("| Day | Count | Bar |");
    lines.push("|-----|-------|-----|");
    for (let d = 0; d < 7; d++) {
      const count = activity.dailyDistribution[d] ?? 0;
      const barLen = Math.round((count / maxDayCount) * 20);
      lines.push(`| ${dayNames[d]} | ${count} | ${"█".repeat(barLen)} |`);
    }
    lines.push("");

    // Top projects
    if (activity.topProjects.length > 0) {
      lines.push("## Most Active Projects", "");
      lines.push("| Project | Entities |");
      lines.push("|---------|----------|");
      for (const { project, count } of activity.topProjects) {
        lines.push(`| ${project} | ${count} |`);
      }
      lines.push("");
    }

    // Domain distribution
    const domainEntries = Object.entries(activity.domainDistribution).sort(
      (a, b) => b[1] - a[1],
    );
    if (domainEntries.length > 0) {
      lines.push("## Domain Distribution", "");
      const total = domainEntries.reduce((s, [, c]) => s + c, 0);
      lines.push("| Domain | Count | % |");
      lines.push("|--------|-------|---|");
      for (const [domain, count] of domainEntries) {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
        lines.push(`| ${domain} | ${count} | ${pct}% |`);
      }
      lines.push("");
    }

    // Entity type distribution
    const typeEntries = Object.entries(activity.typeDistribution).sort(
      (a, b) => b[1] - a[1],
    );
    if (typeEntries.length > 0) {
      lines.push("## Entity Type Distribution", "");
      const total = typeEntries.reduce((s, [, c]) => s + c, 0);
      lines.push("| Type | Count | % |");
      lines.push("|------|-------|---|");
      for (const [type, count] of typeEntries) {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
        lines.push(`| ${type} | ${count} | ${pct}% |`);
      }
      lines.push("");
    }

    // Collaboration graph
    if (collaboration.hubs.length > 0) {
      lines.push("## Top Collaborators", "");
      lines.push("| Person | Connections |");
      lines.push("|--------|-------------|");
      for (const hub of collaboration.hubs) {
        lines.push(`| ${hub.name} | ${hub.connections} |`);
      }
      lines.push("");
    }

    if (collaboration.edges.length > 0) {
      lines.push("## Collaboration Pairs (2+ shared meetings)", "");
      lines.push("| Person A | Person B | Shared Meetings |");
      lines.push("|----------|----------|-----------------|");
      for (const edge of collaboration.edges.slice(0, 20)) {
        lines.push(`| ${edge.personA} | ${edge.personB} | ${edge.sharedMeetings} |`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
