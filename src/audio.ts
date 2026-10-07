// Downloads audio from a user-supplied link into downloads/audio, once: the same link is never fetched twice.

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { HttpError, isPrivateAddress } from "./net.js";

export const AUDIO_DIR = fileURLToPath(new URL("../downloads/audio", import.meta.url));
export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg)$/i;
const SOURCES_FILE = join(AUDIO_DIR, "sources.json");
const MAX_BYTES = 500 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const AUDIO_TYPE = /^(audio\/|video\/mp4|application\/(octet-stream|ogg)|binary\/octet-stream)/i;

export type Sources = Record<string, { show: string; publisher: string; title: string; url: string }>;

export async function readSources(): Promise<Sources> {
  return readFile(SOURCES_FILE, "utf8").then(JSON.parse, () => ({}));
}

async function recordSource(name: string, entry: Sources[string]): Promise<void> {
  const sources = await readSources();
  sources[name] = entry;
  const tmp = `${SOURCES_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(sources, null, 2));
  await rename(tmp, SOURCES_FILE);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/** Absolute path of a file in the audio folder. `name` must be a plain file name that exists there, never a path. */
export async function audioPath(name: string): Promise<string> {
  const path = join(AUDIO_DIR, name);
  if (name !== name.split(/[\\/]/).pop() || !AUDIO_EXT.test(name) || !(await stat(path).catch(() => null))?.isFile()) {
    throw new HttpError("No such audio file.", 404);
  }
  return path;
}

export function parseAudioUrl(link: string): URL {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new HttpError("That doesn't look like a valid link.", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError("Only http(s) links are supported.", 400);
  return url;
}

/** The file a link is saved as: host and file name for readability, plus a hash of the full link so different links never collide. */
export function audioFileName(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const ext = last.match(AUDIO_EXT)?.[0].toLowerCase() ?? ".mp3";
  const hash = createHash("sha1").update(url.href).digest("hex").slice(0, 8);
  return `${slug(url.hostname)}--${slug(last.replace(AUDIO_EXT, "")) || "audio"}-${hash}${ext}`;
}

/** Saves the link's audio as `name` in the audio folder unless it's already there. */
export async function downloadAudio(link: string, name: string): Promise<void> {
  const path = join(AUDIO_DIR, name);
  if (await access(path).then(() => true, () => false)) return;
  await mkdir(AUDIO_DIR, { recursive: true });

  let url = parseAudioUrl(link);
  for (let hop = 0; hop < 5; hop++) {
    const addrs = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some(a => isPrivateAddress(a.address))) throw new HttpError("Could not reach that link.");

    const connect = new AbortController();
    const timer = setTimeout(() => connect.abort(), CONNECT_TIMEOUT_MS); // headers only; the body may take longer
    let r: Response;
    try {
      r = await fetch(url, { redirect: "manual", signal: connect.signal, headers: { "User-Agent": "Mozilla/5.0 (compatible; interview-qa)" } });
    } catch {
      throw new HttpError("Could not download that link.");
    } finally {
      clearTimeout(timer);
    }

    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      await r.body?.cancel();
      url = parseAudioUrl(new URL(r.headers.get("location")!, url).href);
      continue;
    }
    if (!r.ok || !r.body) throw new HttpError(`The link returned an error (HTTP ${r.status}).`);
    if (!AUDIO_TYPE.test(r.headers.get("content-type") ?? "")) {
      await r.body.cancel();
      throw new HttpError("That link isn't an audio file. Paste a direct link to an .mp3 or .m4a.", 422);
    }
    if (Number(r.headers.get("content-length")) > MAX_BYTES) {
      await r.body.cancel();
      throw new HttpError("That audio file is too large (limit 500 MB).", 413);
    }

    const tmp = `${path}.${process.pid}.tmp`;
    let total = 0;
    try {
      await pipeline(Readable.fromWeb(r.body as never), async function* (chunks: AsyncIterable<Buffer>) {
        for await (const chunk of chunks) {
          total += chunk.length;
          if (total > MAX_BYTES) throw new HttpError("That audio file is too large (limit 500 MB).", 413);
          yield chunk;
        }
      }, createWriteStream(tmp));
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      if (e instanceof HttpError) throw e;
      throw new HttpError("The download was interrupted.");
    }
    const first = parseAudioUrl(link);
    await recordSource(name, { show: first.hostname, publisher: first.hostname.replace(/^www\./, ""), title: decodeURIComponent(first.pathname.split("/").pop() ?? "") || first.hostname, url: first.href });
    return;
  }
  throw new HttpError("Too many redirects.");
}
