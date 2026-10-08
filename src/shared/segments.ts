// The intro and outro: ads, show promotion and announcements around the interview, by voices other than its speakers.
// Their utterances carry these labels in place of the diarization letter, so they never count as a host, a guest or an
// interruption, and are shown as "Intro" and "Outro".

import type { Segments, Utterance } from "./types.js";

export const INTRO = "Intro";
export const OUTRO = "Outro";

export const isFiller = (label: string): boolean => label === INTRO || label === OUTRO;

/** The utterances with the intro's and outro's relabeled; unchanged when there are no segments. */
export const labelSegments = (utterances: Utterance[], segments: Segments | undefined): Utterance[] =>
  !segments ? utterances : utterances.map((u, i) =>
    i < segments.start ? { ...u, speaker: INTRO } : i >= segments.end ? { ...u, speaker: OUTRO } : u);
