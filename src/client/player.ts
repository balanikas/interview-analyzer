// The audio player: its controls, the episode title and cost beside them, and keeping the selection in step with the
// audio. Everything else moves playback through playFrom / seek and follows it through the store's `time`.

import type { TranscribeResponse, Utterance } from "../shared/types.js";
import { $ } from "./dom.js";
import { clock } from "./format.js";
import { on, set, state, type SelectionSource } from "./store.js";

const audio = $<HTMLAudioElement>("player");
const playBtn = $<HTMLButtonElement>("playbtn");
const seekBar = $<HTMLInputElement>("seek");

/** Starts playing a new transcript's audio from the beginning, paused. */
export function load(data: TranscribeResponse): void {
  audio.pause();
  audio.src = `/api/audio/${encodeURIComponent(data.file)}`;
}

export function seek(seconds: number): void {
  const end = Number.isFinite(audio.duration) ? audio.duration : Infinity;
  audio.currentTime = Math.min(Math.max(seconds, 0), end);
  publish();
}

export function playFrom(seconds: number): void {
  seek(seconds);
  void audio.play().catch(() => { /* the browser may refuse until the page has been interacted with */ });
}

/** Selects an utterance and plays from `seconds` (its start, or a little before a moment in it). */
export function playMoment(index: number, seconds: number, from: SelectionSource): void {
  set({ selection: { index, from } });
  playFrom(seconds);
}

// The utterance being spoken at `seconds`: the last one that has started (utterances are in time order).
function utteranceAt(utterances: Utterance[], seconds: number): number | null {
  let lo = 0, hi = utterances.length - 1, found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (utterances[mid].start <= seconds) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Moves the playhead, and selects the utterance being spoken when the audio enters a new one.
function publish(): void {
  const { data, selection } = state();
  if (!data) return;
  set({ time: audio.currentTime });
  const i = utteranceAt(data.utterances, audio.currentTime);
  if (i !== selection.index) set({ selection: { index: i, from: "player" } });
}

// ---- Controls ----

let scrubbing = false;
$("backbtn").addEventListener("click", () => seek(audio.currentTime - 10));
$("fwdbtn").addEventListener("click", () => seek(audio.currentTime + 10));
seekBar.addEventListener("pointerdown", () => { scrubbing = true; });
seekBar.addEventListener("input", () => { seek(Number(seekBar.value)); updateControls(); });
for (const type of ["pointerup", "pointercancel", "change"]) seekBar.addEventListener(type, () => { scrubbing = false; });

function updateControls(): void {
  if (Number.isFinite(audio.duration)) seekBar.max = String(audio.duration);
  if (!scrubbing) seekBar.value = String(audio.currentTime);
  $("clock").textContent = `${clock(audio.currentTime)} / ${clock(audio.duration)}`;
  playBtn.textContent = audio.paused ? "▶" : "❚❚";
  playBtn.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
}
playBtn.addEventListener("click", () => {
  if (audio.paused) void audio.play().catch(() => { /* not allowed yet */ }); else audio.pause();
});
for (const type of ["play", "pause", "ended", "seeked", "timeupdate", "loadedmetadata", "durationchange"]) audio.addEventListener(type, updateControls);

// While playing, follow the audio every frame.
let frame = 0;
const tick = () => { publish(); frame = requestAnimationFrame(tick); };
audio.addEventListener("play", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); });
for (const type of ["pause", "ended", "seeked"]) audio.addEventListener(type, () => {
  if (type !== "seeked") cancelAnimationFrame(frame);
  publish();
});

// ---- The episode's title (linking to its page) and what its analysis cost ----

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

on(["data", "files"], ({ data, files }) => {
  if (!data) return;
  const src = files.find(f => f.name === data.file)?.source;
  const title = $("nowtitle");
  if (src && /^https?:\/\//.test(src.url)) {
    const a = document.createElement("a");
    a.href = src.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = src.title;
    title.replaceChildren(a);
  } else {
    title.textContent = src?.title ?? data.file;
  }
  const cost = data.cost;
  $("cost").textContent = cost ? `$${cost.total.toFixed(cost.total < 0.1 ? 3 : 2)}${cost.items.some(i => i.estimated) ? " est." : ""}` : "";
  $("cost").title = cost?.items.map(i => `${capitalize(i.label)}: $${i.usd.toFixed(4)}${i.estimated ? " (estimated)" : ""}`).join("\n") ?? "";
});
