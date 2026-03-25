import { z } from "zod";
import type { CortexStore } from "../store.js";
import type { SafeToolFn } from "./index.js";
import { MemorySteward } from "../steward/index.js";

export function registerStewardTools(
  safeTool: SafeToolFn,
  store: CortexStore,
): void {
  safeTool(
    "memory_audit",
    "Run a data quality audit — find duplicates, stale entities, orphans, and unconfirmed inferred entities",
    {},
    async () => {
      const steward = new MemorySteward(store.database);
      const report = steward.audit();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              duplicates: report.duplicateCandidates.length,
              stale: report.staleEntities,
              orphaned: report.orphanedEntities,
              unconfirmed: report.unconfirmedInferred,
              markdown: report.markdownOutput,
            }),
          },
        ],
      };
    },
  );

  safeTool(
    "memory_briefing",
    "Generate a daily or weekly briefing of recent memory activity — decisions, actions, active projects",
    {
      period: z.enum(["daily", "weekly"]).optional(),
    },
    async ({ period }) => {
      const steward = new MemorySteward(store.database);
      const report = steward.briefing(
        (period as "daily" | "weekly" | undefined) ?? "daily",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              period: report.period,
              newEntities: report.newEntities,
              newDecisions: report.newDecisions.length,
              pendingActions: report.pendingActions.length,
              completedActions: report.completedActions,
              markdown: report.markdownOutput,
            }),
          },
        ],
      };
    },
  );
}
