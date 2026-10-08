// Transcription jobs: download, transcribe, analyze. A job runs on its own, not tied to any request; pages follow its
// progress as a replayable event stream, so a reload or a second tab picks it up, and several can watch one job.
// Each job is saved in cache/jobs while it runs, with AssemblyAI's transcript id as soon as there is one, so when the
// server restarts it resumes waiting for that transcript instead of uploading the audio and paying for it again.

import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import { analyze } from "./analysis/pipeline.js";
import { paths } from "./config.js";
import { downloadAudio, parseAudioUrl } from "./fetch-audio.js";
import { HttpError } from "./net.js";
import { startTranscript, TranscriptFailed, waitForTranscript, type RawTranscript } from "./providers/assemblyai.js";
import type { JobEvent, JobInfo, JobRequest } from "./shared/types.js";
import { fileIn, readJson, removeJson, serialized, writeJson } from "./store/json.js";
import { audioPath, fileNameForLink } from "./store/library.js";
import { readRaw, writeRaw } from "./store/transcripts.js";

const KEEP_FINISHED_MS = 10 * 60_000; // a finished job's events stay available this long, for a page that reconnects

/** What is saved of a job. */
interface Saved {
  id: string;
  file: string;
  /** The link to download first, for a pasted link. */
  url?: string;
  /** AssemblyAI's transcript id, once the audio has been sent. */
  assemblyaiId?: string;
  /** False once the job has ended; the record is kept only to reuse its transcript id. */
  running: boolean;
  log: string[];
}

type Listener = (event: JobEvent, n: number) => void;

class Job {
  readonly events: JobEvent[];
  private readonly listeners = new Set<Listener>();
  private readonly queue = serialized();

  constructor(readonly saved: Saved) {
    this.events = saved.log.map(log => ({ log }));
  }

  get info(): JobInfo { return { id: this.saved.id, file: this.saved.file }; }
  get finished(): boolean { const last = this.events.at(-1); return !!last && !("log" in last); }

  emit(event: JobEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event, this.events.length - 1);
  }

  /** Replays the events from number `from` on, then passes on new ones until the job ends. Returns an unsubscribe. */
  subscribe(from: number, listener: Listener): () => void {
    this.events.slice(from).forEach((e, i) => listener(e, from + i));
    if (this.finished) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Saves the job, or removes the record; in order, so a late save never brings back a removed record. */
  persist(keep: boolean): Promise<void> {
    const path = fileIn(paths.jobs, this.saved.file, ".json");
    const snapshot = structuredClone(this.saved);
    return this.queue(() => (keep ? writeJson(path, snapshot) : removeJson(path)));
  }
}

const jobs = new Map<string, Job>(); // by id
const running = new Map<string, Job>(); // by audio file: one job per file at a time

export const getJob = (id: string): Job | undefined => jobs.get(id);
export const activeJobs = (): JobInfo[] => [...running.values()].map(j => j.info);

/** Starts analyzing a link or a downloaded file, or joins the job already doing it. Bad input is refused right away. */
export async function startJob(request: JobRequest): Promise<JobInfo> {
  let file: string, url: string | undefined;
  if ("audio_url" in request) {
    const parsed = parseAudioUrl(request.audio_url);
    url = parsed.href;
    file = fileNameForLink(parsed);
  } else {
    file = request.file;
    await audioPath(file); // 404 unless it's there
  }
  // An earlier try that failed after sending the audio left its transcript id behind.
  const earlier = await readJson<Saved>(fileIn(paths.jobs, file, ".json"));
  return running.get(file)?.info ?? launch({ id: randomUUID(), file, url, assemblyaiId: earlier?.assemblyaiId, running: true, log: [] });
}

/** Resumes the jobs that were running when the server stopped. */
export async function resumeJobs(): Promise<void> {
  let names: string[];
  try { names = (await readdir(paths.jobs)).filter(n => n.endsWith(".json")); } catch { return; }
  for (const name of names) {
    const saved = await readJson<Saved>(`${paths.jobs}/${name}`);
    if (!saved?.running || running.has(saved.file)) continue;
    console.log(`Resuming the job for ${saved.file}`);
    launch(saved, "the server restarted; picking up where it left off...");
  }
}

function launch(saved: Saved, first?: string): JobInfo {
  const job = new Job(saved);
  jobs.set(saved.id, job);
  running.set(saved.file, job);
  void run(job, first);
  return job.info;
}

async function run(job: Job, first?: string): Promise<void> {
  const { saved } = job;
  const log = (message: string) => {
    saved.log.push(message);
    job.emit({ log: message });
    void job.persist(true);
  };
  if (first) log(first);
  try {
    if (saved.url) { log("downloading audio..."); await downloadAudio(saved.url, saved.file); }
    let raw = await readRaw(saved.file);
    if (raw) log("loading saved transcript...");
    else raw = await transcribe(job, log);
    const result = await analyze(saved.file, raw, log);
    end(job, { done: result });
    await job.persist(false);
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    if (e instanceof TranscriptFailed) delete saved.assemblyaiId;
    saved.running = false;
    end(job, { error: e instanceof HttpError ? e.message : `Server error: ${e instanceof Error ? e.message : String(e)}` });
    await job.persist(!!saved.assemblyaiId);
  }
}

async function transcribe(job: Job, log: (message: string) => void): Promise<RawTranscript> {
  const { saved } = job;
  if (saved.assemblyaiId) log("waiting for the transcription already under way...");
  else {
    log("uploading audio...");
    saved.assemblyaiId = await startTranscript(await audioPath(saved.file));
    await job.persist(true); // before waiting: from here on, a restart resumes rather than paying again
  }
  log("extracting transcript (this can take several minutes)...");
  const raw = await waitForTranscript(saved.assemblyaiId, log);
  await writeRaw(saved.file, raw); // saved before the analysis, so a failed analysis never costs a new transcription
  return raw;
}

function end(job: Job, event: JobEvent): void {
  running.delete(job.saved.file);
  job.emit(event);
  setTimeout(() => jobs.delete(job.saved.id), KEEP_FINISHED_MS).unref();
}
