import express from "express";
import { z } from "zod";

import { renameSpeakers, setHosts } from "./analysis/pipeline.js";
import { config, paths } from "./config.js";
import { activeJobs, getJob, resumeJobs, startJob } from "./jobs.js";
import { HttpError } from "./net.js";
import type { AudioFile, ErrorResponse, HostsRequest, JobRequest, RenameRequest } from "./shared/types.js";
import { audioPath, listLibrary } from "./store/library.js";
import { hasRaw } from "./store/transcripts.js";

// Request bodies, checked at the door; each schema must match the request type the page sends.
const JobBody = z.union([z.object({ audio_url: z.string() }), z.object({ file: z.string() })]) satisfies z.ZodType<JobRequest>;
const RenameBody = z.object({ file: z.string(), names: z.record(z.string(), z.string()) }) satisfies z.ZodType<RenameRequest>;
const HostsBody = z.object({ file: z.string(), hosts: z.array(z.string()) }) satisfies z.ZodType<HostsRequest>;

function parse<S extends z.ZodType>(schema: S, body: unknown, message: string): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new HttpError(message, 400);
  return result.data;
}

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(paths.static));

app.get("/api/audio", async (_req, res: express.Response<AudioFile[]>) => {
  const files = await listLibrary();
  res.json(await Promise.all(files.map(async f => ({ ...f, transcribed: await hasRaw(f.name) }))));
});

// The audio file itself, for the in-page player. sendFile answers range requests, which is what makes seeking work.
app.get("/api/audio/:name", async (req, res, next) => {
  res.sendFile(await audioPath(req.params.name), err => {
    if (err && !res.headersSent) next(err); // a dropped connection (the player seeking) isn't an error worth reporting
  });
});

// Starts analyzing a link (downloaded first) or a downloaded file, or joins the job already doing it. Audio, transcripts
// and analyses are cached, so a repeat is quick.
app.post("/api/jobs", async (req, res) => {
  res.json(await startJob(parse(JobBody, req.body, "Paste a link to an audio file.")));
});

// The jobs running now, so a page that was reloaded can follow its job again.
app.get("/api/jobs", (_req, res) => {
  res.json(activeJobs());
});

// A job's progress as server-sent events: everything so far, then each new event, ending with the result or an error.
// Every event carries its number, so a browser that reconnects (EventSource does by itself) gets only what it missed.
app.get("/api/jobs/:id/events", (req, res: express.Response<ErrorResponse>) => {
  const job = getJob(req.params.id);
  if (!job) return void res.status(404).json({ error: "That job is no longer running." });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const from = Number(req.get("last-event-id") ?? -1) + 1;
  const unsubscribe = job.subscribe(Number.isInteger(from) && from > 0 ? from : 0, (event, n) => {
    res.write(`id: ${n}\ndata: ${JSON.stringify(event)}\n\n`);
    if (!("log" in event)) res.end();
  });
  req.on("close", unsubscribe);
});

// Saves the names a person typed for the speakers of an already transcribed file.
app.post("/api/speakers", async (req, res) => {
  const { file, names } = parse(RenameBody, req.body, "Missing file or names.");
  res.json(await renameSpeakers(file, names));
});

// Marks which speakers are hosts and judges the questions again with them (a panel the automatic pick got wrong).
app.post("/api/hosts", async (req, res) => {
  const { file, hosts } = parse(HostsBody, req.body, "Missing file or hosts.");
  res.json(await setHosts(file, hosts));
});

// Anything a route didn't handle: answer in JSON, since the page always parses JSON. An HttpError is meant for the
// person using the page; anything else is a bug, so it's logged.
app.use((err: unknown, _req: express.Request, res: express.Response<ErrorResponse>, _next: express.NextFunction) => {
  if (!(err instanceof HttpError)) console.error(err);
  if (res.headersSent) return;
  if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
  res.status(500).json({ error: `Server error: ${err instanceof Error ? err.message : String(err)}` });
});

app.listen(config.port, () => {
  console.log(`Listening on http://localhost:${config.port}`);
  if (!config.assemblyaiKey) console.warn("Warning: ASSEMBLYAI_API_KEY isn't set; transcription requests will fail.");
  if (!config.anthropicKey) console.warn("Warning: ANTHROPIC_API_KEY isn't set; speakers will keep their \"Speaker A\" labels.");
  void resumeJobs();
});
