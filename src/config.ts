// Settings and data locations, read once. Every module that needs one imports it from here, so the .env file is loaded
// before anything reads the environment (a module that read process.env at load time used to run before it was loaded).

import { fileURLToPath } from "node:url";

// ASSEMBLYAI_API_KEY, ANTHROPIC_API_KEY and the rest can live in a .env file next to package.json; real env vars win.
try { process.loadEnvFile(); } catch { /* no .env file */ }

const dir = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export const config = {
  port: Number(process.env.PORT ?? 5000),
  assemblyaiKey: process.env.ASSEMBLYAI_API_KEY,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  claudeModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
};

export const paths = {
  static: dir("../static"),
  /** Downloaded audio, plus library.json describing each file. */
  audio: dir("../downloads/audio"),
  /** AssemblyAI's completed transcript jobs, one JSON file per audio file. */
  raw: dir("../cache/assemblyai"),
  /** What the app worked out from each transcript. */
  analysis: dir("../cache/analysis"),
  /** Transcription jobs in progress, so a restart can pick them up again. */
  jobs: dir("../cache/jobs"),
};
