// Finds the intro and outro around the interview: ads, sponsor reads, show promotion and announcements that aren't
// about the interview's topic and aren't spoken by its main speakers. Claude reads the start and end of the transcript,
// told how much each speaker talks overall (the main speakers talk the most), and says where the interview starts and ends.

import { z } from "zod";

import { ask, claudeAvailable } from "../providers/claude.js";
import type { Segments, Utterance } from "../shared/types.js";
import type { Analyzer } from "./analyzer.js";

const HEAD = 40; // utterances from the start, where the intro would be
const TAIL = 25; // and from the end, for the outro
const MAX_UTTERANCE_CHARS = 300;

const SYSTEM_PROMPT = `You find where the interview starts and ends in a podcast or broadcast transcript. Before it \
there may be an intro: ads, sponsor reads, promotion of the show or of other shows, network announcements. After it \
there may be an outro of the same kind. Each line is an utterance id, a speaker label (a letter assigned by \
diarization) and what was said; you get the start and the end of the transcript, and how much each label speaks in \
the whole recording (the interview's main speakers speak the most).
Intro and outro are only material that is not about the interview's topic AND is not spoken by a main speaker. \
Anything on the topic is part of the interview, wherever it comes: a host setting up the story, news clips or quotes \
about it, a teaser of what the guest will say. So is a main speaker opening the show, welcoming listeners, \
introducing the guest, thanking the guest or signing off. When unsure, keep it in the interview.
interview_start - the id of the first utterance of the interview; the first id shown when there is no intro.
interview_end - the id of the last utterance of the interview; the last id shown when there is no outro.`;

const Reply = z.object({ interview_start: z.number().int(), interview_end: z.number().int() });

/** Each speaker's share of the talk time, to tell the main speakers from ad and promo voices. */
function shares(utterances: Utterance[]): string {
  const seconds = new Map<string, number>();
  for (const u of utterances) seconds.set(u.speaker, (seconds.get(u.speaker) ?? 0) + u.end - u.start);
  const total = [...seconds.values()].reduce((a, b) => a + b, 0) || 1;
  return [...seconds].sort((a, b) => b[1] - a[1]).map(([s, t]) => `${s} ${Math.round((t / total) * 100)}%`).join(", ");
}

export const segments: Analyzer<"segments"> = {
  key: "segments",
  version: 1,
  message: "finding the intro and outro...",
  async run(utterances) {
    const n = utterances.length;
    const none: Segments = { start: 0, end: n };
    if (!n) return { value: none, costs: [] };
    if (!claudeAvailable()) return { value: null, costs: [] };
    const shown = utterances.map((u, i) => ({ u, i })).filter(({ i }) => i < HEAD || i >= n - TAIL);
    const lines = shown.map(({ u, i }, k) =>
      (k > 0 && shown[k - 1].i !== i - 1 ? "…\n" : "") + `#${i} [${u.speaker}] ${u.text.slice(0, MAX_UTTERANCE_CHARS)}`);
    try {
      const { value, cost } = await ask({
        label: "intro and outro", system: SYSTEM_PROMPT, schema: Reply, maxTokens: 4096, // room to think first; 256 ran out mid-thought, leaving no answer
        content: `Talk time: ${shares(utterances)}\n\n${lines.join("\n")}`,
      });
      if (!value) return { value: null, costs: [cost] };
      // Only an intro inside the start shown, and an outro inside the end shown, are believed.
      const start = value.interview_start > 0 && value.interview_start < Math.min(HEAD, n) ? value.interview_start : 0;
      const end = value.interview_end >= n - TAIL && value.interview_end < n - 1 ? value.interview_end + 1 : n;
      return { value: start < end ? { start, end } : none, costs: [cost] };
    } catch (e) {
      console.error("Couldn't find the intro and outro:", e instanceof Error ? e.message : e);
      return { value: null, costs: [] };
    }
  },
};
