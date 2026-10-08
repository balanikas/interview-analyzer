// AssemblyAI's API: upload audio, start a diarized transcript, wait for it. Nothing here touches the caches; the job
// runner records the transcript id as soon as it has one, so a restart resumes waiting instead of paying again.

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { config } from "../config.js";
import { HttpError } from "../net.js";

const API = "https://api.assemblyai.com/v2";
const POLL_MS = 5_000;
const MAX_WAIT_MS = 60 * 60_000;
const SPEECH_MODELS = ["universal-3-5-pro", "universal-2"];

/** AssemblyAI's transcript job as it came back when completed, times in milliseconds. */
export interface RawTranscript {
  status: string;
  error?: string;
  audio_duration?: number | null;
  speech_model_used?: string;
  utterances?: { speaker: string; text: string; start: number; end: number }[] | null;
}

/** The transcript job itself failed (as opposed to the request for it), so its id is no use any more. */
export class TranscriptFailed extends HttpError {}

async function api<T>(path: string, init: RequestInit & { duplex?: "half" } = {}): Promise<T> {
  if (!config.assemblyaiKey) throw new HttpError("Transcription isn't set up on the server.", 500);
  const r = await fetch(`${API}${path}`, { ...init, headers: { authorization: config.assemblyaiKey, ...init.headers } });
  const body = await r.json().catch(() => ({})) as T & { error?: string };
  // AssemblyAI refusing the request itself (as opposed to being down) means a transcript id it was given is no good.
  const Failure = r.status === 400 || r.status === 404 ? TranscriptFailed : HttpError;
  if (!r.ok) throw new Failure(`Transcription failed: ${body.error ?? `HTTP ${r.status}`}`);
  return body;
}

/** Uploads a local file and starts transcribing it; resolves with the transcript id. */
export async function startTranscript(path: string): Promise<string> {
  const { upload_url } = await api<{ upload_url: string }>("/upload", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Readable.toWeb(createReadStream(path)) as never,
    duplex: "half",
  });
  const { id } = await api<{ id: string }>("/transcript", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Universal-3.5 Pro has the most accurate diarization but covers 18 languages; anything else falls back to Universal-2.
    body: JSON.stringify({ audio_url: upload_url, speech_models: SPEECH_MODELS, speaker_labels: true, language_detection: true }),
  });
  return id;
}

/** Polls a transcript until it's done. */
export async function waitForTranscript(id: string, log: (message: string) => void): Promise<RawTranscript> {
  const deadline = Date.now() + MAX_WAIT_MS;
  for (;;) {
    const job = await api<RawTranscript>(`/transcript/${encodeURIComponent(id)}`);
    if (job.status === "error") throw new TranscriptFailed(`Couldn't transcribe it: ${job.error ?? "unknown error"}`);
    if (job.status === "completed") {
      if (job.speech_model_used) log(`transcribed with ${job.speech_model_used}`);
      return job;
    }
    if (Date.now() > deadline) throw new HttpError("Timed out while transcribing.", 504);
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
