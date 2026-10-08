// JSON files on disk: read (null when missing or unreadable) and atomic write (a crash never leaves half a file).

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { HttpError } from "../net.js";

export async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

export async function removeJson(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** `name` as a file in `dir`; refused unless it's a plain file name, never a path. */
export function fileIn(dir: string, name: string, ext = ""): string {
  if (!name || name !== name.split(/[\\/]/).pop() || name === "." || name === "..") throw new HttpError("No such file.", 404);
  return join(dir, name + ext);
}

/** Runs read-modify-write updates of one file one after another, so concurrent updates in this process never lose one. */
export function serialized(): <T>(work: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return work => {
    const run = tail.then(work, work);
    tail = run.catch(() => {});
    return run;
  };
}
