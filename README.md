# Interview Timeline

Paste a link to an interview's audio → the app downloads it (once), has AssemblyAI transcribe it with speaker labels and timestamps (once), and shows a speaker timeline (one row per speaker, one bar per stretch of speech) above the transcript. Click a bar to highlight its transcript line, or a line to highlight its bar.

Already-downloaded audio is listed in a collapsible "Downloaded audio" section with each file's source link, length and a Transcribe / Show transcript button.

## Run

Requires Node.js 20+.

```bash
npm install
cp .env.example .env   # then fill in your API keys (or export them)
npm run dev          # http://localhost:5000, restarts on server changes
```

For production: `npm run build && npm start`. Optional: `PORT`.

To fetch some short political interviews from public podcast RSS feeds: `npx tsx src/download-audio.ts` (edit `FEEDS` in the file to change shows).

## Layout

Server (`src/`):
- `server.ts` — routes only: `GET /api/audio`, `POST /api/jobs` (`{ audio_url }` or `{ file }`) → `{ id }`, `GET /api/jobs` (running jobs), `GET /api/jobs/:id/events` (server-sent progress, then the result), `POST /api/speakers`, `POST /api/hosts`. Request bodies are checked with zod.
- `config.ts` — settings from the environment / `.env`, and the data folders
- `jobs.ts` — runs a job (download → transcribe → analyze) apart from any request; saved in `cache/jobs/` so a restart resumes it
- `fetch-audio.ts` — safe download of an audio link (private addresses refused, 500 MB cap)
- `providers/assemblyai.ts` — AssemblyAI upload / start / poll, nothing else
- `providers/claude.ts` — one `ask()` for structured answers: a zod schema in, a typed value and its cost out
- `analysis/` — the analyzers (`speakers`, `interruptions`, `exchanges`), each with its own version, and `pipeline.ts`, which runs whichever are missing or out of date
- `store/` — the files on disk: `library.ts` (audio + `library.json`), `transcripts.ts` (raw + analysis caches)
- `download-audio.ts` — script that downloads episodes from podcast RSS feeds, through the same downloader and library

Shared (`src/shared/`): `types.d.ts` (API types) and `scores.ts` (scorecard rules and speaker stats — pure functions).

Page (`src/client/`, compiled to `static/client/`): `store.ts` holds the page state; each panel (`transcript`, `timeline-view`, `stats`, `interruptions`, `exchanges`, `picker`, `player`) subscribes to what it shows. `analyze.ts` starts and follows jobs; `timeline.ts` draws the SVG.

## Notes

- Audio is saved in `downloads/audio/`; `library.json` there records each file's source and length. A pasted link's file name is made from its host, file name and a hash of the full link, so the same link is never downloaded twice. Delete a file to fetch it again.
- AssemblyAI's transcripts are cached in `cache/assemblyai/`, the analysis in `cache/analysis/`, one JSON file per audio file. Delete the first to transcribe again, the second to analyze again. Bumping an analyzer's `version` redoes just that analysis the next time a transcript is opened.
- A job that has sent its audio to AssemblyAI records the transcript id first, so neither a restart nor a retry pays for it twice. Reloading the page follows the running job again.
- Speakers are named from what is said when `ANTHROPIC_API_KEY` is set (`ANTHROPIC_MODEL` picks the model); otherwise they keep AssemblyAI's labels ("Speaker A").
- Links to internal/private addresses are refused; files over 500 MB are refused.
