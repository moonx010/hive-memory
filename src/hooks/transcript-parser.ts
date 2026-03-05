import { readFile } from "node:fs/promises";

export interface ParsedSession {
  projectPath: string | null;
  summary: string;
  decisions: string[];
  learnings: string[];
  nextTasks: string[];
  alreadySaved: boolean;
}

interface TranscriptMessage {
  role?: string;
  type?: string;
  tool?: string;
  content?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args?: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  result?: any;
}

/**
 * Parse a Claude Code JSONL transcript file.
 * Returns structured session data extracted from the conversation.
 */
export async function parseTranscript(transcriptPath: string): Promise<ParsedSession> {
  const raw = await readFile(transcriptPath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);
  const messages: TranscriptMessage[] = [];

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  let projectPath: string | null = null;
  let alreadySaved = false;
  const summaryParts: string[] = [];
  const decisions: string[] = [];
  const learnings: string[] = [];

  for (const msg of messages) {
    // Detect project directory from tool calls
    if (msg.tool === "Bash" && msg.args?.command) {
      const cmd = msg.args.command as string;
      const cdMatch = cmd.match(/^cd\s+(.+)/);
      if (cdMatch && !projectPath) {
        projectPath = cdMatch[1].replace(/["']/g, "").trim();
      }
    }

    // Check if session_save was already called
    if (msg.tool === "session_save" || msg.tool?.includes("session_save")) {
      alreadySaved = true;
    }

    // Extract assistant messages for summary
    if (msg.role === "assistant" && msg.content && typeof msg.content === "string") {
      // Collect key assistant outputs
      if (msg.content.length > 50 && msg.content.length < 2000) {
        summaryParts.push(msg.content);
      }
    }

    // Extract decisions and learnings from memory_store calls
    if (msg.tool === "memory_store" && msg.args) {
      const category = msg.args.category as string;
      const content = msg.args.content as string;
      if (category === "decision" && content) decisions.push(content);
      if (category === "learning" && content) learnings.push(content);
    }
  }

  // Build a summary from the conversation
  const summary = buildSummary(summaryParts);

  return {
    projectPath,
    summary,
    decisions,
    learnings,
    nextTasks: [],
    alreadySaved,
  };
}

function buildSummary(parts: string[]): string {
  if (parts.length === 0) return "Session completed (no summary available)";

  // Take the last few meaningful messages as summary
  const relevant = parts.slice(-3);
  const combined = relevant.join(" ").slice(0, 500);
  return combined || "Session completed";
}
