// Downloads audio from a link into downloads/audio, once: a file already there isn't fetched again. Links can come from
// anyone using the page, so private addresses are refused (at every redirect) and the size is capped.

import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { paths } from "./config.js";
import { HttpError, isPrivateAddress } from "./net.js";
import type { AudioSource } from "./shared/types.js";
import { hasAudio, recordAudio } from "./store/library.js";

const MAX_BYTES = 500 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const AUDIO_TYPE = /^(audio\/|video\/mp4|application\/(octet-stream|ogg)|binary\/octet-stream)/i;

export function parseAudioUrl(link: string): URL {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new HttpError("That doesn't look like a valid link.", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new HttpError("Only http(s) links are supported.", 400);
  return url;
}

// A pasted link has no show or title, so the host and the link's file name stand in.
function sourceOfLink(url: URL): AudioSource {
  const host = url.hostname;
  return { show: host, publisher: host.replace(/^www\./, ""), title: decodeURIComponent(url.pathname.split("/").pop() ?? "") || host, url: url.href };
}

/** Saves the link's audio as `name` in the audio folder unless it's already there, and records it in the library. */
export async function downloadAudio(link: string, name: string, source?: AudioSource): Promise<void> {
  if (await hasAudio(name)) return;
  const path = join(paths.audio, name);
  await mkdir(paths.audio, { recursive: true });

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
    await recordAudio(name, source ?? sourceOfLink(parseAudioUrl(link)));
    return;
  }
  throw new HttpError("Too many redirects.");
}
