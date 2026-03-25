import { z } from "zod";
import { existsSync } from "node:fs";
import type { CortexStore } from "../store.js";
import type { SafeToolFn } from "./index.js";
import { MeetingAgent } from "../meeting/agent.js";

export function registerMeetingTools(
  safeTool: SafeToolFn,
  store: CortexStore,
): void {
  safeTool(
    "meeting_process",
    "Process a meeting transcript to extract decisions, action items, and create structured meeting notes",
    {
      transcriptPath: z.string(),
      title: z.string().optional(),
      date: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      calendarEventId: z.string().optional(),
    },
    async ({ transcriptPath, title, date, attendees, calendarEventId }) => {
      if (!existsSync(transcriptPath as string)) {
        throw new Error(`Transcript file not found: ${transcriptPath}`);
      }

      const agent = new MeetingAgent(
        store.database,
        store.enrichmentEngine,
      );

      const result = await agent.process({
        transcriptPath: transcriptPath as string,
        title: title as string | undefined,
        date: date as string | undefined,
        attendees: attendees as string[] | undefined,
        calendarEventId: calendarEventId as string | undefined,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              meetingEntityId: result.meetingEntityId,
              speakers: result.speakers,
              decisionsCreated: result.decisionsCreated,
              actionsCreated: result.actionsCreated,
              markdown: result.markdownOutput,
            }),
          },
        ],
      };
    },
  );
}
