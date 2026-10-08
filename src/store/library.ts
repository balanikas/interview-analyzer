// The downloaded audio: the files in downloads/audio, and library.json recording where each came from and how long it
// is. Both the server and the podcast script go through here, so the record has one format and one writer, and a file's
// length is read once when it's recorded rather than on every listing.

import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { parseFile } from "music-metadata";

import { paths } from "../config.js";
import { HttpError } from "../net.js";
import type { AudioSource } from "../shared/types.js";
import { fileIn, readJson, serialized, writeJson } from "./json.js";

export const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg)$/i;
const LIBRARY_FILE = join(paths.audio, "library.json");

export interface LibraryEntry {
  source: AudioSource | null;
  /** Length in seconds; null when it can't be read from the file. */
  duration: number | null;
}

type Library = Record<string, LibraryEntry>;

const readLibrary = async (): Promise<Library> => (await readJson<Library>(LIBRARY_FILE)) ?? {};
const update = serialized();

const durationOf = (path: string) => parseFile(path, { duration: true }).then(m => m.format.duration ?? null, () => null);

/** Records a file in the library, reading its length; `source` replaces the one recorded, if given. */
export function recordAudio(name: string, source?: AudioSource): Promise<LibraryEntry> {
  return update(async () => {
    const library = await readLibrary();
    const entry = {
      source: source ?? library[name]?.source ?? null,
      duration: library[name]?.duration ?? await durationOf(join(paths.audio, name)),
    };
    library[name] = entry;
    await writeJson(LIBRARY_FILE, library);
    return entry;
  });
}

/** Every audio file in the folder with its library entry. A file put there by hand is recorded the first time it's seen. */
export async function listLibrary(): Promise<({ name: string; size: number } & LibraryEntry)[]> {
  let names: string[];
  try { names = (await readdir(paths.audio)).filter(n => AUDIO_EXT.test(n)).sort(); } catch { return []; }
  const library = await readLibrary();
  const out = [];
  for (const name of names) {
    const entry = library[name] ?? await recordAudio(name);
    out.push({ name, size: (await stat(join(paths.audio, name))).size, ...entry });
  }
  return out;
}

/** Absolute path of a file in the audio folder. `name` must be a plain file name that exists there, never a path. */
export async function audioPath(name: string): Promise<string> {
  const path = AUDIO_EXT.test(name) ? fileIn(paths.audio, name) : null;
  if (!path || !(await stat(path).catch(() => null))?.isFile()) throw new HttpError("No such audio file.", 404);
  return path;
}

export const hasAudio = (name: string) => audioPath(name).then(() => true, () => false);

// HTML entities are dropped first: feed titles carry them ("Q&amp;A").
export const slug = (s: string, max = 60) =>
  s.toLowerCase().replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max);

const extOf = (url: URL, fallback = ".mp3") => decodeURIComponent(url.pathname).match(AUDIO_EXT)?.[0].toLowerCase() ?? fallback;

/** A pasted link's file: host and file name for readability, plus a hash of the full link so different links never collide. */
export function fileNameForLink(url: URL): string {
  const last = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const hash = createHash("sha1").update(url.href).digest("hex").slice(0, 8);
  return `${slug(url.hostname)}--${slug(last.replace(AUDIO_EXT, "")) || "audio"}-${hash}${extOf(url)}`;
}

/** A podcast episode's file: the feed's key and the episode title. */
export function fileNameForEpisode(feedKey: string, title: string, enclosure: URL): string {
  return `${feedKey}--${slug(title, 80)}${extOf(enclosure)}`;
}
