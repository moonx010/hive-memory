/**
 * Speech-to-Text wrapper for meeting audio files.
 *
 * Supports:
 *   - OpenAI Whisper (local, via CLI: `whisper`)
 *   - Deepgram API (cloud, via DEEPGRAM_API_KEY)
 *
 * Produces VTT transcript files from audio/video input.
 * Requires ffmpeg for audio extraction from video files.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, basename, dirname, extname } from "node:path";
import { tmpdir } from "node:os";

export interface STTOptions {
  /** Input audio/video file path */
  inputPath: string;
  /** Output directory for transcript files (default: same as input) */
  outputDir?: string;
  /** Whisper model size: tiny, base, small, medium, large (default: base) */
  model?: string;
  /** Language hint (default: auto-detect) */
  language?: string;
  /** Use Deepgram API instead of local Whisper */
  useDeepgram?: boolean;
}

export interface STTResult {
  /** Path to generated VTT file */
  vttPath: string;
  /** Detected/specified language */
  language: string;
  /** Duration in seconds */
  durationSeconds: number;
  /** STT engine used */
  engine: "whisper" | "deepgram";
}

const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".avi", ".mov"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"];

/**
 * Transcribe an audio/video file to VTT format.
 */
export async function transcribeToVTT(opts: STTOptions): Promise<STTResult> {
  if (!existsSync(opts.inputPath)) {
    throw new Error(`Input file not found: ${opts.inputPath}`);
  }

  const ext = extname(opts.inputPath).toLowerCase();
  let audioPath = opts.inputPath;

  // Extract audio from video if needed
  if (VIDEO_EXTENSIONS.includes(ext)) {
    audioPath = await extractAudio(opts.inputPath);
    console.error(`[stt] Extracted audio: ${audioPath}`);
  } else if (!AUDIO_EXTENSIONS.includes(ext) && ext !== ".vtt" && ext !== ".srt") {
    throw new Error(`Unsupported file format: ${ext}`);
  }

  // If already a transcript file, just return it
  if (ext === ".vtt" || ext === ".srt") {
    return {
      vttPath: opts.inputPath,
      language: opts.language ?? "auto",
      durationSeconds: 0,
      engine: "whisper",
    };
  }

  if (opts.useDeepgram) {
    return transcribeWithDeepgram(audioPath, opts);
  }

  return transcribeWithWhisper(audioPath, opts);
}

/**
 * Extract audio track from video file using ffmpeg.
 */
async function extractAudio(videoPath: string): Promise<string> {
  const outputPath = join(
    tmpdir(),
    `hive-stt-${basename(videoPath, extname(videoPath))}.wav`,
  );

  try {
    execSync(
      `ffmpeg -i "${videoPath}" -vn -acodec pcm_s16le -ar 16000 -ac 1 "${outputPath}" -y`,
      { stdio: "pipe" },
    );
  } catch (err) {
    throw new Error(
      `ffmpeg audio extraction failed: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }

  return outputPath;
}

/**
 * Transcribe using local Whisper CLI.
 */
async function transcribeWithWhisper(
  audioPath: string,
  opts: STTOptions,
): Promise<STTResult> {
  const model = opts.model ?? "base";
  const outputDir = opts.outputDir ?? dirname(audioPath);
  mkdirSync(outputDir, { recursive: true });

  const langFlag = opts.language ? `--language ${opts.language}` : "";

  console.error(`[stt] Running Whisper (model: ${model})...`);

  try {
    execSync(
      `whisper "${audioPath}" --model ${model} --output_format vtt --output_dir "${outputDir}" ${langFlag}`,
      { stdio: "pipe", timeout: 600000 }, // 10 min timeout
    );
  } catch (err) {
    throw new Error(
      `Whisper transcription failed: ${err instanceof Error ? err.message : err}`,
      { cause: err },
    );
  }

  const vttName = basename(audioPath, extname(audioPath)) + ".vtt";
  const vttPath = join(outputDir, vttName);

  if (!existsSync(vttPath)) {
    throw new Error(`Whisper did not produce VTT output at ${vttPath}`);
  }

  // Get duration from ffprobe
  let durationSeconds = 0;
  try {
    const probe = execSync(
      `ffprobe -v error -show_entries format=duration -of csv=p=0 "${audioPath}"`,
      { encoding: "utf-8" },
    );
    durationSeconds = Math.round(parseFloat(probe.trim()));
  } catch {
    // ignore
  }

  return {
    vttPath,
    language: opts.language ?? "auto",
    durationSeconds,
    engine: "whisper",
  };
}

/**
 * Transcribe using Deepgram API.
 */
async function transcribeWithDeepgram(
  audioPath: string,
  opts: STTOptions,
): Promise<STTResult> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) {
    throw new Error("DEEPGRAM_API_KEY environment variable is required for Deepgram STT");
  }

  console.error("[stt] Uploading to Deepgram...");

  const audioData = readFileSync(audioPath);
  const res = await fetch(
    "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true&diarize=true",
    {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": "audio/wav",
      },
      body: audioData,
    },
  );

  if (!res.ok) {
    throw new Error(`Deepgram API error: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    results: {
      utterances?: Array<{
        start: number;
        end: number;
        transcript: string;
        speaker: number;
      }>;
      channels: Array<{
        alternatives: Array<{
          transcript: string;
          words: Array<{
            start: number;
            end: number;
            word: string;
            speaker?: number;
          }>;
        }>;
      }>;
    };
    metadata: { duration: number };
  };

  // Convert to VTT
  const vttLines: string[] = ["WEBVTT", ""];
  const utterances = data.results.utterances ?? [];

  for (const utt of utterances) {
    const start = formatVTTTime(utt.start);
    const end = formatVTTTime(utt.end);
    const speaker = `Speaker ${utt.speaker + 1}`;
    vttLines.push(`${start} --> ${end}`);
    vttLines.push(`<v ${speaker}>${utt.transcript}`);
    vttLines.push("");
  }

  const outputDir = opts.outputDir ?? dirname(audioPath);
  mkdirSync(outputDir, { recursive: true });
  const vttPath = join(
    outputDir,
    basename(audioPath, extname(audioPath)) + ".vtt",
  );
  writeFileSync(vttPath, vttLines.join("\n"));

  return {
    vttPath,
    language: opts.language ?? "auto",
    durationSeconds: Math.round(data.metadata.duration),
    engine: "deepgram",
  };
}

function formatVTTTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}
