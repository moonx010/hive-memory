import { readFileSync } from "node:fs";

export interface TranscriptTurn {
  speaker: string;
  text: string;
  startTime?: string;
  endTime?: string;
}

export interface ParsedTranscript {
  turns: TranscriptTurn[];
  speakers: string[];
  durationMinutes: number;
  plaintext: string;
  format: "vtt" | "srt" | "plaintext";
}

/**
 * Parse a meeting transcript from a file.
 * Auto-detects format: WebVTT, SubRip (SRT), or plain text.
 */
export function parseTranscript(filePath: string): ParsedTranscript {
  const content = readFileSync(filePath, "utf-8");
  return parseTranscriptContent(content);
}

export function parseTranscriptContent(content: string): ParsedTranscript {
  const trimmed = content.trim();

  if (trimmed.startsWith("WEBVTT")) {
    return parseVTT(trimmed);
  }

  // SRT detection: starts with a number followed by timestamp line
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(trimmed)) {
    return parseSRT(trimmed);
  }

  return parsePlainText(trimmed);
}

function parseVTT(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  const blocks = content.split(/\n\n+/);
  let minTime = Infinity;
  let maxTime = 0;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 2) continue;

    // Find timestamp line
    const tsIdx = lines.findIndex((l) =>
      /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(l),
    );
    if (tsIdx === -1) continue;

    const tsLine = lines[tsIdx];
    const [startStr, endStr] = tsLine.split("-->").map((s) => s.trim());
    const startSecs = parseTimestamp(startStr);
    const endSecs = parseTimestamp(endStr);
    if (startSecs < minTime) minTime = startSecs;
    if (endSecs > maxTime) maxTime = endSecs;

    // Text lines after timestamp
    const textLines = lines.slice(tsIdx + 1);
    let speaker = "";
    let text = textLines.join(" ");

    // VTT speaker via <v Speaker> tag
    const voiceMatch = text.match(/<v\s+([^>]+)>/);
    if (voiceMatch) {
      speaker = voiceMatch[1].trim();
      text = text.replace(/<v\s+[^>]+>/g, "").replace(/<\/v>/g, "").trim();
    }

    // Fallback: "Speaker: text" pattern
    if (!speaker) {
      const colonMatch = text.match(/^([A-Za-z][A-Za-z\s.'-]{0,30}):\s+(.+)/);
      if (colonMatch) {
        speaker = colonMatch[1].trim();
        text = colonMatch[2].trim();
      }
    }

    if (text) {
      turns.push({
        speaker: speaker || "Unknown",
        text,
        startTime: startStr,
        endTime: endStr,
      });
    }
  }

  return buildResult(turns, minTime, maxTime, "vtt");
}

function parseSRT(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  const blocks = content.split(/\n\n+/);
  let minTime = Infinity;
  let maxTime = 0;

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    // Line 1: sequence number, Line 2: timestamp, Line 3+: text
    const tsLine = lines[1];
    if (!/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(tsLine)) continue;

    const [startStr, endStr] = tsLine
      .split("-->")
      .map((s) => s.trim().replace(",", "."));
    const startSecs = parseTimestamp(startStr);
    const endSecs = parseTimestamp(endStr);
    if (startSecs < minTime) minTime = startSecs;
    if (endSecs > maxTime) maxTime = endSecs;

    const textLines = lines.slice(2);
    let text = textLines.join(" ");
    let speaker = "";

    const colonMatch = text.match(/^([A-Za-z][A-Za-z\s.'-]{0,30}):\s+(.+)/);
    if (colonMatch) {
      speaker = colonMatch[1].trim();
      text = colonMatch[2].trim();
    }

    if (text) {
      turns.push({
        speaker: speaker || "Unknown",
        text,
        startTime: startStr,
        endTime: endStr,
      });
    }
  }

  return buildResult(turns, minTime, maxTime, "srt");
}

function parsePlainText(content: string): ParsedTranscript {
  const turns: TranscriptTurn[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const colonMatch = trimmed.match(
      /^([A-Za-z][A-Za-z\s.'-]{0,30}):\s+(.+)/,
    );
    if (colonMatch) {
      turns.push({
        speaker: colonMatch[1].trim(),
        text: colonMatch[2].trim(),
      });
    } else {
      turns.push({ speaker: "Unknown", text: trimmed });
    }
  }

  return buildResult(turns, 0, 0, "plaintext");
}

function parseTimestamp(ts: string): number {
  const parts = ts.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!parts) return 0;
  return (
    parseInt(parts[1]) * 3600 +
    parseInt(parts[2]) * 60 +
    parseInt(parts[3]) +
    parseInt(parts[4]) / 1000
  );
}

function buildResult(
  turns: TranscriptTurn[],
  minTime: number,
  maxTime: number,
  format: ParsedTranscript["format"],
): ParsedTranscript {
  const speakers = [...new Set(turns.map((t) => t.speaker).filter((s) => s !== "Unknown"))];
  const durationMinutes =
    minTime < maxTime ? Math.round((maxTime - minTime) / 60) : 0;
  const plaintext = turns
    .map((t) => (t.speaker !== "Unknown" ? `${t.speaker}: ${t.text}` : t.text))
    .join("\n");

  return { turns, speakers, durationMinutes, plaintext, format };
}
