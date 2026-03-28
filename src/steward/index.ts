import type { HiveDatabase } from "../db/database.js";
import type { Entity } from "../types.js";
import type { ACLContext } from "../acl/types.js";

export interface StewardReport {
  duplicateCandidates: Array<{
    entityA: { id: string; title: string; source: string };
    entityB: { id: string; title: string; source: string };
    reason: string;
  }>;
  staleEntities: number;
  orphanedEntities: number;
  unconfirmedInferred: number;
  unresolvedConflicts: number;
  markdownOutput: string;
}

export interface BriefingReport {
  period: "daily" | "weekly";
  newEntities: number;
  newDecisions: Array<{ id: string; title: string }>;
  pendingActions: Array<{ id: string; title: string; owner: string }>;
  completedActions: number;
  topProjects: Array<{ project: string; entityCount: number }>;
  markdownOutput: string;
}

export class MemorySteward {
  private acl?: ACLContext;
  constructor(private db: HiveDatabase, acl?: ACLContext) {
    this.acl = acl;
  }

  /**
   * Run data quality audit — find duplicates, stale data, orphans.
   */
  audit(): StewardReport {
    // 1. Find duplicate person candidates (same name, different source)
    const persons = this.db.listEntities({ acl: this.acl, entityType: "person", limit: 500 });
    const nameMap = new Map<string, Entity[]>();
    for (const p of persons) {
      const key = (p.title ?? "").toLowerCase().trim();
      if (key.length < 2) continue;
      const list = nameMap.get(key) ?? [];
      list.push(p);
      nameMap.set(key, list);
    }

    const duplicateCandidates: StewardReport["duplicateCandidates"] = [];
    for (const [, entities] of nameMap) {
      if (entities.length < 2) continue;
      for (let i = 0; i < entities.length; i++) {
        for (let j = i + 1; j < entities.length; j++) {
          if (entities[i].source.system !== entities[j].source.system) {
            duplicateCandidates.push({
              entityA: {
                id: entities[i].id,
                title: entities[i].title ?? "",
                source: entities[i].source.system,
              },
              entityB: {
                id: entities[j].id,
                title: entities[j].title ?? "",
                source: entities[j].source.system,
              },
              reason: "Same name, different source",
            });
          }
        }
      }
    }

    // 2. Count stale entities (not updated in 90 days)
    const staleDate = new Date(
      Date.now() - 90 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const staleEntities = this.db.listEntities({ acl: this.acl,
      until: staleDate,
      limit: 1000,
    }).length;

    // 3. Orphaned entities (no synapses)
    const allEntities = this.db.listEntities({ acl: this.acl, limit: 500 });
    let orphanedEntities = 0;
    for (const entity of allEntities) {
      const synapses = this.db.getSynapsesByEntry(entity.id, "both");
      if (synapses.length === 0 && entity.entityType !== "person") {
        orphanedEntities++;
      }
    }

    // 4. Unconfirmed inferred entities
    const inferred = this.db.listEntities({ acl: this.acl, limit: 1000 }).filter(
      (e) => e.confidence === "inferred",
    );

    // 5. Count unresolved conflicts (conflict synapses between two active entities)
    const conflictSynapses = this.db.getSynapsesByAxon("conflict");
    const unresolvedConflicts = conflictSynapses.filter((c) => {
      const source = this.db.getEntity(c.source, this.acl);
      const target = this.db.getEntity(c.target, this.acl);
      return source?.status === "active" && target?.status === "active";
    });

    // Render markdown
    const lines: string[] = [
      "# Memory Steward Audit Report",
      "",
      `**Date:** ${new Date().toISOString().split("T")[0]}`,
      "",
      "## Data Quality Summary",
      "",
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Duplicate person candidates | ${duplicateCandidates.length} |`,
      `| Stale entities (>90 days) | ${staleEntities} |`,
      `| Orphaned entities (no synapses) | ${orphanedEntities} |`,
      `| Unconfirmed inferred entities | ${inferred.length} |`,
      `| Unresolved conflicts | ${unresolvedConflicts.length} |`,
      "",
    ];

    if (duplicateCandidates.length > 0) {
      lines.push("## Duplicate Candidates", "");
      for (const d of duplicateCandidates.slice(0, 20)) {
        lines.push(
          `- **${d.entityA.title}** (${d.entityA.source}) ↔ **${d.entityB.title}** (${d.entityB.source})`,
        );
      }
      lines.push("");
    }

    if (unresolvedConflicts.length > 0) {
      lines.push("## Unresolved Conflicts", "");
      for (const c of unresolvedConflicts.slice(0, 20)) {
        lines.push(`- ${c.source} ↔ ${c.target} (weight: ${c.weight.toFixed(2)})`);
      }
      lines.push("");
    }

    return {
      duplicateCandidates,
      staleEntities,
      orphanedEntities,
      unconfirmedInferred: inferred.length,
      unresolvedConflicts: unresolvedConflicts.length,
      markdownOutput: lines.join("\n"),
    };
  }

  /**
   * Generate a daily or weekly briefing of recent memory activity.
   */
  briefing(period: "daily" | "weekly" = "daily"): BriefingReport {
    const daysBack = period === "daily" ? 1 : 7;
    const since = new Date(
      Date.now() - daysBack * 24 * 60 * 60 * 1000,
    ).toISOString();

    // New entities
    const newEntities = this.db.listEntities({ acl: this.acl, since, limit: 500 });

    // New decisions
    const newDecisions = newEntities
      .filter((e) => e.entityType === "decision")
      .map((e) => ({ id: e.id, title: e.title ?? e.content.slice(0, 80) }));

    // Pending actions
    const allTasks = this.db.listEntities({ acl: this.acl,
      entityType: "task",
      limit: 100,
    });
    const pendingActions = allTasks
      .filter((e) => e.attributes?.actionStatus === "open")
      .map((e) => ({
        id: e.id,
        title: e.title ?? e.content.slice(0, 80),
        owner: (e.attributes?.owner as string) ?? "unassigned",
      }));
    const completedActions = allTasks.filter(
      (e) => e.attributes?.actionStatus === "done",
    ).length;

    // Top projects by entity count
    const projectCounts = new Map<string, number>();
    for (const e of newEntities) {
      if (e.project) {
        projectCounts.set(e.project, (projectCounts.get(e.project) ?? 0) + 1);
      }
    }
    const topProjects = [...projectCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([project, entityCount]) => ({ project, entityCount }));

    // Render markdown
    const periodLabel = period === "daily" ? "Daily" : "Weekly";
    const lines: string[] = [
      `# ${periodLabel} Memory Briefing`,
      "",
      `**Period:** ${since.split("T")[0]} — ${new Date().toISOString().split("T")[0]}`,
      "",
      "## Overview",
      "",
      `- **New entities:** ${newEntities.length}`,
      `- **New decisions:** ${newDecisions.length}`,
      `- **Pending actions:** ${pendingActions.length}`,
      `- **Completed actions:** ${completedActions}`,
      "",
    ];

    if (newDecisions.length > 0) {
      lines.push("## Recent Decisions", "");
      for (const d of newDecisions.slice(0, 10)) {
        lines.push(`- ${d.title}`);
      }
      lines.push("");
    }

    if (pendingActions.length > 0) {
      lines.push("## Pending Action Items", "");
      for (const a of pendingActions.slice(0, 10)) {
        lines.push(`- [ ] ${a.title} — ${a.owner}`);
      }
      lines.push("");
    }

    if (topProjects.length > 0) {
      lines.push("## Most Active Projects", "");
      for (const p of topProjects) {
        lines.push(`- **${p.project}**: ${p.entityCount} new entities`);
      }
      lines.push("");
    }

    return {
      period,
      newEntities: newEntities.length,
      newDecisions,
      pendingActions,
      completedActions,
      topProjects,
      markdownOutput: lines.join("\n"),
    };
  }
}
