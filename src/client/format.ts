// How times, shares and speakers are written on the page.

import { speakerOrder } from "../shared/scores.js";
import { isFiller } from "../shared/segments.js";
import type { TranscribeResponse } from "../shared/types.js";

/** Seconds as m:ss, or h:mm:ss from an hour on. */
export function clock(seconds: number): string {
  const t = Math.floor(Number.isFinite(seconds) ? seconds : 0), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;

/** A speaker's name, or "Speaker A" while it isn't known; "Intro" and "Outro" for those. */
export const nameOf = (data: TranscribeResponse | null, label: string): string =>
  isFiller(label) ? label : data?.names?.[label] || `Speaker ${label}`;

const ROLE_BY_SLOT = ["interviewer", "interviewee", "other"]; // reuses the three speaker colours

/** The colour class of each speaker: by order of first appearance, everyone after the second sharing the third. */
export function speakerClasses(data: TranscribeResponse): (label: string) => string {
  const order = speakerOrder(data.utterances);
  return label => (isFiller(label) ? "filler" : ROLE_BY_SLOT[Math.min(order.indexOf(label), ROLE_BY_SLOT.length - 1)]);
}
