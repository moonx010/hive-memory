import type { HiveDatabase } from "../db/database.js";
import type { Entity } from "../types.js";

export interface WorkflowInsight {
  type: "repeated-topic" | "decision-bottleneck" | "stale-action" | "collaboration-gap";
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  entities: string[]; // related entity IDs
}

export interface AdvisorReport {
  insights: WorkflowInsight[];
  stats: {
    totalDecisions: number;
    avgDecisionsPerWeek: number;
    totalActions: number;
    openActions: number;
    overdueActions: number;
    topCollaborators: Array<{ name: string; interactions: number }>;
  };
  markdownOutput: string;
}

function computeJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.slice(0, 5));
  const setB = new Set(b.slice(0, 5));
  const intersection = [...setA].filter((k) => setB.has(k)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

export class WorkflowAdvisor {
  constructor(private db: HiveDatabase) {}

  analyze(): AdvisorReport {
    const insights: WorkflowInsight[] = [];

    // ── 1. Repeated Topics ─────────────────────────────────────────────────────
    const withKeywords = this.db.listEntities({ hasKeywords: true, limit: 500 });
    const repeatedInsights = this.detectRepeatedTopics(withKeywords);
    insights.push(...repeatedInsights);

    // ── 2. Decision Bottleneck ─────────────────────────────────────────────────
    const decisions = this.db.listEntities({ entityType: "decision", limit: 500 });
    const bottleneckInsights = this.detectDecisionBottlenecks(decisions, withKeywords);
    insights.push(...bottleneckInsights);

    // ── 3. Stale Actions ───────────────────────────────────────────────────────
    const tasks = this.db.listEntities({ entityType: "task", limit: 500 });
    const staleInsights = this.detectStaleActions(tasks);
    insights.push(...staleInsights);

    // ── 4. Collaboration Gaps ──────────────────────────────────────────────────
    const meetings = this.db.listEntities({ entityType: "meeting", limit: 200 });
    const gapInsights = this.detectCollaborationGaps(meetings, decisions, tasks);
    insights.push(...gapInsights);

    // ── Stats ──────────────────────────────────────────────────────────────────
    const stats = this.computeStats(decisions, tasks, meetings);

    // ── Markdown ───────────────────────────────────────────────────────────────
    const markdownOutput = this.renderMarkdown(insights, stats);

    return { insights, stats, markdownOutput };
  }

  private detectRepeatedTopics(entities: Entity[]): WorkflowInsight[] {
    const insights: WorkflowInsight[] = [];

    // Group entities by keyword cluster: find sets of 3+ entities from different dates
    // that share similar keywords (Jaccard >= 0.4)
    const groups: Entity[][] = [];

    for (let i = 0; i < entities.length; i++) {
      if (entities[i].keywords.length === 0) continue;

      let placed = false;
      for (const group of groups) {
        // Check if this entity matches the group's first member
        const jaccard = computeJaccard(entities[i].keywords, group[0].keywords);
        if (jaccard >= 0.4) {
          group.push(entities[i]);
          placed = true;
          break;
        }
      }
      if (!placed) {
        groups.push([entities[i]]);
      }
    }

    for (const group of groups) {
      if (group.length < 3) continue;

      // Check that entities come from different dates
      const dates = new Set(
        group.map((e) => e.createdAt.split("T")[0]),
      );
      if (dates.size < 2) continue;

      const topKeywords = group[0].keywords.slice(0, 3).join(", ");
      insights.push({
        type: "repeated-topic",
        severity: "info",
        title: `Repeated topic: "${topKeywords}"`,
        description: `${group.length} entities across ${dates.size} different dates discuss the same keywords (${topKeywords}). Consider consolidating into a decision or reference document.`,
        entities: group.map((e) => e.id),
      });
    }

    return insights;
  }

  private detectDecisionBottlenecks(
    decisions: Entity[],
    allEntities: Entity[],
  ): WorkflowInsight[] {
    const insights: WorkflowInsight[] = [];
    const BOTTLENECK_DAYS = 14;

    for (const decision of decisions) {
      if (decision.keywords.length === 0) continue;

      // Find the earliest entity with overlapping keywords
      let earliestMs: number | null = null;
      let earliestId: string | null = null;

      for (const entity of allEntities) {
        if (entity.id === decision.id) continue;
        if (entity.entityType === "decision") continue;
        const jaccard = computeJaccard(decision.keywords, entity.keywords);
        if (jaccard >= 0.4) {
          const ts = new Date(entity.createdAt).getTime();
          if (earliestMs === null || ts < earliestMs) {
            earliestMs = ts;
            earliestId = entity.id;
          }
        }
      }

      if (earliestMs !== null && earliestId !== null) {
        const decisionMs = new Date(decision.createdAt).getTime();
        const diffDays = (decisionMs - earliestMs) / (1000 * 60 * 60 * 24);
        if (diffDays > BOTTLENECK_DAYS) {
          insights.push({
            type: "decision-bottleneck",
            severity: "warning",
            title: `Slow decision: "${decision.title ?? decision.content.slice(0, 60)}"`,
            description: `This decision took ${Math.round(diffDays)} days to reach after the topic first appeared. Topics discussed for >14 days without a decision may indicate a bottleneck.`,
            entities: [decision.id, earliestId],
          });
        }
      }
    }

    return insights;
  }

  private detectStaleActions(tasks: Entity[]): WorkflowInsight[] {
    const insights: WorkflowInsight[] = [];
    const now = Date.now();

    for (const task of tasks) {
      if (task.attributes?.actionStatus !== "open") continue;

      const createdMs = new Date(task.createdAt).getTime();
      const ageDays = (now - createdMs) / (1000 * 60 * 60 * 24);

      if (ageDays > 30) {
        insights.push({
          type: "stale-action",
          severity: "critical",
          title: `Critically stale action: "${task.title ?? task.content.slice(0, 60)}"`,
          description: `This open action item is ${Math.round(ageDays)} days old (>30 days). It may be abandoned or forgotten.`,
          entities: [task.id],
        });
      } else if (ageDays > 7) {
        insights.push({
          type: "stale-action",
          severity: "warning",
          title: `Stale action: "${task.title ?? task.content.slice(0, 60)}"`,
          description: `This open action item is ${Math.round(ageDays)} days old (>7 days). Consider reviewing its status.`,
          entities: [task.id],
        });
      }
    }

    return insights;
  }

  private detectCollaborationGaps(
    meetings: Entity[],
    decisions: Entity[],
    tasks: Entity[],
  ): WorkflowInsight[] {
    const insights: WorkflowInsight[] = [];

    // Build meeting → attendees map via "attended" synapses
    const meetingAttendees = new Map<string, Set<string>>();
    for (const meeting of meetings) {
      const synapses = this.db.getSynapsesByEntry(meeting.id, "incoming", "attended");
      const attendees = new Set(synapses.map((s) => s.source));
      if (attendees.size >= 2) {
        meetingAttendees.set(meeting.id, attendees);
      }
    }

    // Find person pairs that co-attended meetings
    const coMeetingPairs = new Map<string, Set<string>>(); // "A:B" → meeting IDs
    for (const [meetingId, attendees] of meetingAttendees) {
      const arr = [...attendees];
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const key = arr[i] < arr[j] ? `${arr[i]}:${arr[j]}` : `${arr[j]}:${arr[i]}`;
          const meetingSet = coMeetingPairs.get(key) ?? new Set();
          meetingSet.add(meetingId);
          coMeetingPairs.set(key, meetingSet);
        }
      }
    }

    // Build set of person pairs that co-occur in decisions or tasks
    const coDecisionPairs = new Set<string>();
    const allWorkEntities = [...decisions, ...tasks];
    for (const entity of allWorkEntities) {
      const synapses = this.db.getSynapsesByEntry(entity.id, "incoming");
      const authors = synapses
        .filter((s) => s.axon === "authored" || s.axon === "attended")
        .map((s) => s.source);
      for (let i = 0; i < authors.length; i++) {
        for (let j = i + 1; j < authors.length; j++) {
          const key = authors[i] < authors[j]
            ? `${authors[i]}:${authors[j]}`
            : `${authors[j]}:${authors[i]}`;
          coDecisionPairs.add(key);
        }
      }
    }

    // Find pairs that meet together but never co-appear in decisions/actions
    for (const [pair, meetingSet] of coMeetingPairs) {
      if (meetingSet.size >= 2 && !coDecisionPairs.has(pair)) {
        const [personA, personB] = pair.split(":");
        const entityA = this.db.getEntity(personA);
        const entityB = this.db.getEntity(personB);
        const nameA = entityA?.title ?? personA;
        const nameB = entityB?.title ?? personB;

        insights.push({
          type: "collaboration-gap",
          severity: "info",
          title: `Collaboration gap: ${nameA} & ${nameB}`,
          description: `${nameA} and ${nameB} have attended ${meetingSet.size} meetings together but never co-appear in decisions or actions. They may benefit from more direct collaboration.`,
          entities: [personA, personB],
        });
      }
    }

    return insights;
  }

  private computeStats(
    decisions: Entity[],
    tasks: Entity[],
    meetings: Entity[],
  ): AdvisorReport["stats"] {
    const totalDecisions = decisions.length;
    const totalActions = tasks.length;
    const openActions = tasks.filter(
      (t) => t.attributes?.actionStatus === "open",
    ).length;
    const overdueDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const overdueActions = tasks.filter((t) => {
      if (t.attributes?.actionStatus !== "open") return false;
      return new Date(t.createdAt) < overdueDate;
    }).length;

    // Compute avg decisions per week
    let avgDecisionsPerWeek = 0;
    if (decisions.length > 0) {
      const sorted = [...decisions].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
      const earliest = new Date(sorted[0].createdAt).getTime();
      const latest = new Date(sorted[sorted.length - 1].createdAt).getTime();
      const spanWeeks = Math.max(1, (latest - earliest) / (1000 * 60 * 60 * 24 * 7));
      avgDecisionsPerWeek = Math.round((decisions.length / spanWeeks) * 10) / 10;
    }

    // Top collaborators: count person co-occurrences via attended synapses to same meetings
    const personMeetingCount = new Map<string, number>();
    for (const meeting of meetings) {
      const synapses = this.db.getSynapsesByEntry(meeting.id, "incoming", "attended");
      for (const s of synapses) {
        personMeetingCount.set(s.source, (personMeetingCount.get(s.source) ?? 0) + 1);
      }
    }

    const topCollaborators = [...personMeetingCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, interactions]) => {
        const entity = this.db.getEntity(id);
        return { name: entity?.title ?? id, interactions };
      });

    return {
      totalDecisions,
      avgDecisionsPerWeek,
      totalActions,
      openActions,
      overdueActions,
      topCollaborators,
    };
  }

  private renderMarkdown(
    insights: WorkflowInsight[],
    stats: AdvisorReport["stats"],
  ): string {
    const lines: string[] = [
      "# Workflow Advisor Report",
      "",
      `**Generated:** ${new Date().toISOString().split("T")[0]}`,
      "",
      "## Stats",
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Total decisions | ${stats.totalDecisions} |`,
      `| Avg decisions/week | ${stats.avgDecisionsPerWeek} |`,
      `| Total actions | ${stats.totalActions} |`,
      `| Open actions | ${stats.openActions} |`,
      `| Overdue actions (>7 days) | ${stats.overdueActions} |`,
      "",
    ];

    if (stats.topCollaborators.length > 0) {
      lines.push("## Top Collaborators", "");
      for (const c of stats.topCollaborators) {
        lines.push(`- **${c.name}**: ${c.interactions} meeting interactions`);
      }
      lines.push("");
    }

    const critical = insights.filter((i) => i.severity === "critical");
    const warnings = insights.filter((i) => i.severity === "warning");
    const infos = insights.filter((i) => i.severity === "info");

    if (critical.length > 0) {
      lines.push("## Critical Issues", "");
      for (const ins of critical) {
        lines.push(`### ${ins.title}`, "", ins.description, "");
      }
    }

    if (warnings.length > 0) {
      lines.push("## Warnings", "");
      for (const ins of warnings) {
        lines.push(`### ${ins.title}`, "", ins.description, "");
      }
    }

    if (infos.length > 0) {
      lines.push("## Observations", "");
      for (const ins of infos) {
        lines.push(`### ${ins.title}`, "", ins.description, "");
      }
    }

    if (insights.length === 0) {
      lines.push("## No issues found", "", "All workflow patterns look healthy.");
    }

    return lines.join("\n");
  }
}
