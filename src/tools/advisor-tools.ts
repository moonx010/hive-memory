import { z } from "zod";
import type { HiveDatabase } from "../db/database.js";
import type { SafeToolFn, ACLResolver, GetUserContext } from "./index.js";
import { WorkflowAdvisor } from "../advisor/index.js";
import { PatternAnalyzer } from "../advisor/patterns.js";

export function registerAdvisorTools(
  safeTool: SafeToolFn,
  db: HiveDatabase,
  _aclResolver?: ACLResolver,
  _getUserContext?: GetUserContext,
): void {
  safeTool(
    "workflow_analyze",
    "Analyze accumulated data to find team workflow patterns and suggest improvements — detects repeated topics, decision bottlenecks, stale actions, and collaboration gaps",
    {},
    async () => {
      const advisor = new WorkflowAdvisor(db);
      const report = advisor.analyze();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              insights: report.insights,
              stats: report.stats,
              markdown: report.markdownOutput,
            }),
          },
        ],
      };
    },
  );

  safeTool(
    "pattern_analyze",
    "Analyze aggregated working patterns — activity heatmap, collaboration graph, domain and type distribution. Privacy-aware: aggregated team patterns only, not individual tracking.",
    {
      since: z.string().optional(),
      project: z.string().optional(),
    },
    async ({ since, project }) => {
      const analyzer = new PatternAnalyzer(db);
      const report = analyzer.analyze({
        since: since as string | undefined,
        project: project as string | undefined,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              period: report.period,
              totalEntities: Object.values(report.activity.typeDistribution).reduce(
                (s, c) => s + c,
                0,
              ),
              topProjects: report.activity.topProjects,
              collaborationEdges: report.collaboration.edges.length,
              hubs: report.collaboration.hubs,
              markdown: report.markdownOutput,
            }),
          },
        ],
      };
    },
  );
}
