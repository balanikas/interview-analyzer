// Analyzing: start a job (or join one), show its progress as a terminal-style log, then the result. A file whose
// analysis is already saved opens straight away. A job outlives the page, so a reload follows the running one again.

import type { AudioFile, JobInfo, JobRequest, TranscribeResponse } from "../shared/types.js";
import { followJob, getJson, postJson } from "./api.js";
import { $, h, setStatus } from "./dom.js";
import { load } from "./player.js";
import { on, set, state } from "./store.js";

on(["busy"], ({ busy }) => { $<HTMLButtonElement>("go").disabled = busy; });

function show(data: TranscribeResponse): void {
  $("logbox").hidden = true;
  $("result").hidden = !data.utterances.length;
  $("empty").hidden = data.utterances.length > 0;
  if (!data.utterances.length) return;
  load(data);
  set({ data, selection: { index: null, from: "player" }, time: 0 });
}

function logLine(text: string, cls = ""): void {
  $("log").append(h("div", cls, text));
  $("logbox").scrollTop = $("logbox").scrollHeight;
}

export async function loadAudio(): Promise<void> {
  try {
    set({ files: await getJson<AudioFile[]>("/api/audio") });
  } catch {
    setStatus("Couldn't list the downloaded audio.", true);
  }
}

async function run(job: () => Promise<JobInfo>, cached: boolean): Promise<void> {
  if (state().busy) return;
  set({ busy: true });
  setStatus("");
  $("result").hidden = true;
  $("empty").hidden = true;
  $("log").replaceChildren();
  $("logbox").hidden = false;
  try {
    const data = await followJob((await job()).id, message => logLine(message));
    if (cached) {
      show(data);
      if (!data.utterances.length) setStatus("No speech was found in that audio.");
    } else {
      logLine(data.utterances.length ? "done." : "done. No speech was found in that audio.", "ok");
      if (data.utterances.length) {
        const view = h("button", "", "View");
        view.type = "button";
        view.addEventListener("click", () => show(data));
        $("log").append(view);
        view.focus();
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) { $("logbox").hidden = true; setStatus(message, true); $("empty").hidden = false; }
    else logLine(`error: ${message}`, "err");
  } finally {
    await loadAudio(); // the file may be new, and its transcript is now saved
    set({ busy: false });
  }
}

export const analyze = (request: JobRequest, cached: boolean) => run(() => postJson<JobInfo>("/api/jobs", request), cached);

/** Follows a job that was already running when the page loaded. */
export async function rejoin(): Promise<void> {
  const [job] = await getJson<JobInfo[]>("/api/jobs").catch(() => []);
  if (job) await run(async () => job, false);
}
