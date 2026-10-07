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

- `src/server.ts` — Express server: `GET /api/audio`, `POST /api/transcribe` (`{ audio_url }` or `{ file }`)
- `src/audio.ts` — safe download of an audio link into `downloads/audio/`, with `sources.json` recording where each file came from
- `src/assemblyai.ts` — upload, transcribe with diarization, poll; lists the audio folder
- `src/net.ts` — private-address check and the HTTP error type
- `src/download-audio.ts` — script that downloads episodes from podcast RSS feeds
- `src/client/main.ts` — browser code, compiled to `static/main.js`
- `src/client/timeline.ts` — speaker-timeline SVG
- `src/shared/types.d.ts` — request/response types shared by both
- `static/index.html` — page markup and styles

## Notes

- Audio is saved in `downloads/audio/` under a name made from the link's host, file name and a hash of the full link, so the same link is never downloaded twice. Delete a file to fetch it again.
- Transcripts are cached in `cache/transcripts/` as one JSON file per audio file (times in seconds). Delete one to transcribe again.
- Speakers are AssemblyAI's labels ("Speaker A", "Speaker B"), not names.
- Links to internal/private addresses are refused; files over 500 MB are refused.
