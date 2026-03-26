import { z } from "zod";
import type { CortexStore } from "../store.js";
import { validateId } from "../store/io.js";
import type { SafeToolFn, UserContext } from "./index.js";

export function registerSessionTools(safeTool: SafeToolFn, store: CortexStore, _userContext?: UserContext) {
  safeTool(
    "session_save",
    "Save session progress for a project — what was done and what's next. Call this at the end of a work session.",
    {
      project: z.string().describe("Project ID"),
      summary: z.string().describe("What was accomplished in this session"),
      nextTasks: z.array(z.string()).optional().describe("Tasks to do next"),
      decisions: z.array(z.string()).optional().describe("Decisions made during this session"),
      learnings: z.array(z.string()).optional().describe("Things learned during this session"),
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
