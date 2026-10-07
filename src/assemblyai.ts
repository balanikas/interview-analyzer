// Transcribes a downloaded audio file with AssemblyAI (speaker diarization on) and caches the result per file.

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { parseFile } from "music-metadata";

import { AUDIO_DIR, AUDIO_EXT, audioFileName, audioPath, downloadAudio, parseAudioUrl, readSources } from "./audio.js";
import { addCosts, assemblyAiCost } from "./cost.js";
import { HttpError } from "./net.js";
import { detectExchanges } from "./exchanges.js";
import { detectInterruptions } from "./interruptions.js";
import { inferNames } from "./speakers.js";
import type { AudioFile, CostItem, TranscribeResponse, Utterance } from "./shared/types.js";

const API = "https://api.assemblyai.com/v2";
const TRANSCRIPT_DIR = fileURLToPath(new URL("../cache/transcripts", import.meta.url));
const POLL_MS = 5_000;
const MAX_WAIT_MS = 60 * 60_000;

export async function listAudio(): Promise<AudioFile[]> {
  let names: string[];
  try { names = await readdir(AUDIO_DIR); } catch { return []; }
  const sources = await readSources();
  return Promise.all(names.filter(n => AUDIO_EXT.test(n)).sort().map(async name => ({
    name,
    size: (await stat(join(AUDIO_DIR, name))).size,
    duration: await parseFile(join(AUDIO_DIR, name), { duration: true }).then(m => m.format.duration ?? null, () => null),
    source: sources[name] ?? null,
    transcribed: (await readTranscript(name)) !== null,
  })));
}

const transcriptPath = (name: string) => join(TRANSCRIPT_DIR, `${name}.json`);

async function readTranscript(name: string): Promise<TranscribeResponse | null> {
  try { return JSON.parse(await readFile(transcriptPath(name), "utf8")) as TranscribeResponse; } catch { return null; }
}

async function writeTranscript(name: string, result: TranscribeResponse): Promise<void> {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });
  const tmp = `${transcriptPath(name)}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(result, null, 2));
  await rename(tmp, transcriptPath(name));
}

async function api<T>(path: string, init: RequestInit & { duplex?: "half" } = {}): Promise<T> {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new HttpError("Transcription isn't set up on the server.", 500);
  const r = await fetch(`${API}${path}`, { ...init, headers: { authorization: key, ...init.headers } });
  const body = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new HttpError(`Transcription failed: ${body.error ?? `HTTP ${r.status}`}`);
  return body;
}

type Log = (message: string) => void;

const inFlight = new Map<string, Promise<TranscribeResponse>>();

/**
 * The diarized, timestamped transcript of a file already in the audio folder, or of an audio link (downloaded first).
 * A file or link already processed isn't downloaded or sent again, and one being processed now is shared.
 */
export function transcribe(target: { file: string } | { url: string }, log: Log = () => {}): Promise<TranscribeResponse> {
  const url = "url" in target ? parseAudioUrl(target.url) : null;
  const name = "url" in target ? audioFileName(url!) : target.file;
  const pending = inFlight.get(name);
  if (pending) { log("already in progress, waiting for it..."); return pending; }
  const job = (async () => {
    if (url) { log("downloading audio..."); await downloadAudio(url.href, name); }
    return run(name, log);
  })().finally(() => inFlight.delete(name));
  inFlight.set(name, job);
  return job;
}

async function run(name: string, log: Log): Promise<TranscribeResponse> {
  const cached = await readTranscript(name);
  if (cached) {
    // Transcripts saved before names, interruptions or exchanges were worked out, or when that failed, get another try.
    log("loading saved transcript...");
    const costs: CostItem[] = [];
    // Transcripts saved before costs were tracked get AssemblyAI's estimated charge; their Claude calls can't be recovered.
    if (!cached.cost && cached.duration) costs.push(assemblyAiCost(cached.duration));
    const [names, interruptions, exchanges] = await Promise.all([
      cached.names ? undefined : step(log, "analyzing speakers...", inferNames(cached.utterances, costs)),
      cached.interruptions ? undefined : step(log, "finding interruptions...", detectInterruptions(cached.utterances, costs)),
      cached.exchanges ? undefined : step(log, "finding exchanges and tagging...", detectExchanges(cached.utterances, costs)),
    ]);
    if (names) cached.names = names;
    if (interruptions) cached.interruptions = interruptions;
    if (exchanges) cached.exchanges = exchanges;
    if (costs.length) cached.cost = addCosts(cached.cost, costs);
    if (names || interruptions || exchanges || costs.length) await writeTranscript(name, cached);
    return cached;
  }

  const path = await audioPath(name);

  log("uploading audio...");
  const { upload_url } = await api<{ upload_url: string }>("/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Readable.toWeb(createReadStream(path)) as never,
    duplex: "half",
  });
  const { id } = await api<{ id: string }>("/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ audio_url: upload_url, speaker_labels: true, language_detection: true }),
  });

  log("extracting transcript (this can take several minutes)...");
  type Job = { status: string; error?: string; audio_duration?: number;
               utterances?: { speaker: string; text: string; start: number; end: number }[] | null };
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const job = await api<Job>(`/transcript/${id}`);
    if (job.status === "error") throw new HttpError(`Couldn't transcribe it: ${job.error ?? "unknown error"}`);
    if (job.status === "completed") {
      const utterances: Utterance[] = (job.utterances ?? []).map(u => ({
        speaker: u.speaker, start: u.start / 1000, end: u.end / 1000, text: u.text,
      }));
      const costs: CostItem[] = job.audio_duration ? [assemblyAiCost(job.audio_duration)] : [];
      const [names, interruptions, exchanges] = await Promise.all([
        step(log, "analyzing speakers...", inferNames(utterances, costs)),
        step(log, "finding interruptions...", detectInterruptions(utterances, costs)),
        step(log, "finding exchanges and tagging...", detectExchanges(utterances, costs)),
      ]);
      const result: TranscribeResponse = { file: name, duration: job.audio_duration ?? null, utterances,
                                           ...(names && { names }), ...(interruptions && { interruptions }), ...(exchanges && { exchanges }),
                                           cost: addCosts(undefined, costs) };
      await writeTranscript(name, result);
      return result;
    }
    if (Date.now() > deadline) throw new HttpError("Timed out while transcribing.", 504);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

// Logs the message as the work starts.
function step<T>(log: Log, message: string, work: Promise<T>): Promise<T> {
  log(message);
  return work;
}

/** Saves the names a person typed for a transcript's speakers, replacing the earlier ones; a blank name goes back to "Speaker X". */
export async function renameSpeakers(file: string, names: Record<string, string>): Promise<TranscribeResponse> {
  const transcript = file === file.split(/[\\/]/).pop() ? await readTranscript(file) : null;
  if (!transcript) throw new HttpError("No transcript for that file yet.", 404);
  const labels = new Set(transcript.utterances.map(u => u.speaker));
  transcript.names = Object.fromEntries(
    Object.entries(names ?? {})
      .map(([label, name]) => [label, typeof name === "string" ? name.trim().slice(0, 80) : ""] as const)
      .filter(([label, name]) => labels.has(label) && name),
  );
  await writeTranscript(file, transcript);
  return transcript;
}
