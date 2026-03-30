import { z } from "zod";
import type { CortexStore } from "../store.js";
import { validateId } from "../store/io.js";
import type { SafeToolFn } from "./index.js";

export function registerSessionTools(safeTool: SafeToolFn, store: CortexStore) {
  safeTool(
    "session_save",
    "Save session summary — focus on what git log CANNOT tell: decision rationale, rejected alternatives, verbal agreements, blockers, cross-project context, and next steps with reasoning. Skip listing commits or code changes.",
    {
      project: z.string().describe("Project ID"),
      summary: z.string().describe("Session summary — focus on WHY decisions were made, not WHAT code changed (git has that)"),
      nextTasks: z.array(z.string()).optional().describe("Tasks to do next, with context on priority or reasoning"),
      decisions: z.array(z.string()).optional().describe("Decisions made — include the rationale and rejected alternatives, not just the outcome"),
      learnings: z.array(z.string()).optional().describe("Non-obvious insights — things future sessions should know that aren't in the code"),
    },
    async (args) => {
      const projectId = args.project as string;
      validateId(projectId);
      const today = new Date().toISOString().slice(0, 10);
      await store.saveSession(projectId, {
        date: today,
        summary: args.summary as string,
        nextTasks: (args.nextTasks as string[] | undefined) ?? [],
        decisions: (args.decisions as string[] | undefined) ?? [],
        learnings: (args.learnings as string[] | undefined) ?? [],
      });
      const syncNote = store.localSyncEnabled ? " Local .cortex.md synced." : "";
      return {
        content: [
          { type: "text" as const, text: `Session saved for ${projectId} (${today}). ${(args.nextTasks as string[] | undefined)?.length ?? 0} next tasks recorded.${syncNote}` },
        ],
      };
    },
  );
}
