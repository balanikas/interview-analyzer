import { fileURLToPath } from "node:url";

import express from "express";

import { listAudio, renameSpeakers, transcribe } from "./assemblyai.js";
import { audioPath } from "./audio.js";
import { HttpError } from "./net.js";
import type { ErrorResponse, RenameRequest, TranscribeEvent, TranscribeResponse } from "./shared/types.js";

// Settings such as ASSEMBLYAI_API_KEY and ANTHROPIC_API_KEY can live in a .env file next to package.json; real env vars win.
try { process.loadEnvFile(); } catch { /* no .env file */ }

const STATIC_DIR = fileURLToPath(new URL("../static", import.meta.url));

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.static(STATIC_DIR));

app.get("/api/audio", async (_req, res) => {
  res.json(await listAudio());
});

// The audio file itself, for the in-page player. sendFile answers range requests, which is what makes seeking work.
app.get("/api/audio/:name", async (req, res, next) => {
  try {
    res.sendFile(await audioPath(req.params.name), err => {
      if (err && !res.headersSent) next(err); // a dropped connection (the player seeking) isn't an error worth reporting
    });
  } catch (e) {
    if (e instanceof HttpError) return void res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// Downloads an audio link (or takes a file already downloaded), sends it to AssemblyAI and waits for the diarized,
// timestamped transcript (minutes for a long episode). Audio and transcripts are cached, so repeats are instant.
// Answers with a stream of JSON lines (TranscribeEvent): progress messages, then the result or an error.
app.post("/api/transcribe", async (req, res: express.Response<ErrorResponse>) => {
  const { file, audio_url: url } = req.body ?? {};
  if (typeof url !== "string" && typeof file !== "string") return res.status(400).json({ error: "Paste a link to an audio file." });
  res.type("application/x-ndjson");
  const send = (event: TranscribeEvent) => void res.write(JSON.stringify(event) + "\n");
  try {
    send({ done: await transcribe(typeof url === "string" ? { url } : { file }, log => send({ log })) });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    send({ error: e instanceof HttpError ? e.message : `Server error: ${e instanceof Error ? e.message : String(e)}` });
  }
  res.end();
});

// Saves the names a person typed for the speakers of an already transcribed file.
app.post("/api/speakers", async (req, res: express.Response<TranscribeResponse | ErrorResponse>) => {
  const { file, names }: Partial<RenameRequest> = req.body ?? {};
  if (typeof file !== "string" || !names || typeof names !== "object") return res.status(400).json({ error: "Missing file or names." });
  try {
    res.json(await renameSpeakers(file, names));
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

// Anything a route didn't handle: log it and answer in JSON, since the client always parses JSON.
app.use((err: unknown, _req: express.Request, res: express.Response<ErrorResponse>, _next: express.NextFunction) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: `Server error: ${err instanceof Error ? err.message : String(err)}` });
});

const port = Number(process.env.PORT ?? 5000);
app.listen(port, () => {
  console.log(`Listening on http://localhost:${port}`);
  if (!process.env.ASSEMBLYAI_API_KEY) console.warn("Warning: ASSEMBLYAI_API_KEY isn't set; transcription requests will fail.");
  if (!process.env.ANTHROPIC_API_KEY) console.warn("Warning: ANTHROPIC_API_KEY isn't set; speakers will keep their \"Speaker A\" labels.");
});
