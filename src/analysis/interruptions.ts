// Finds moments where one speaker cuts in on another. Diarization never reports two people talking at once, so the
// evidence is indirect: candidates are turns that end unfinished right before a speaker change (cut off), and short
// interjections inside someone else's turn (talk over). Claude then judges each candidate from its context.

import { z } from "zod";

import { ask, claudeAvailable } from "../providers/claude.js";
import type { Interruption, Utterance } from "../shared/types.js";
import { inBatches, type Analyzer, type Result } from "./analyzer.js";

const MAX_GAP = 0.5; // seconds between the end of one turn and the start of the next for it to count as a cut-in
const MAX_INTERJECTION_WORDS = 3;
const BATCH = 150; // candidates per request, so one request stays small; batches run in parallel and all are judged

interface Candidate {
  index: number;
  kind: Interruption["kind"];
}

const words = (text: string) => text.match(/\S+/g)?.length ?? 0;

// A turn that ends on a dash, or with no closing punctuation, was left unfinished.
const unfinished = (text: string) => /[—–]\s*$/.test(text) || !/[.?!…"”’')\]]\s*$/.test(text.trim());

/** Speaker changes that might be interruptions: cut off mid-thought, or a short interjection into another's turn. */
export function findCandidates(utterances: Utterance[]): Candidate[] {
  const found: Candidate[] = [];
  for (let i = 1; i < utterances.length; i++) {
    const prev = utterances[i - 1], cur = utterances[i], next = utterances[i + 1];
    if (prev.speaker === cur.speaker) continue;
    if (unfinished(prev.text) && cur.start - prev.end < MAX_GAP) found.push({ index: i, kind: "cut_off" });
    else if (words(cur.text) <= MAX_INTERJECTION_WORDS && next?.speaker === prev.speaker) found.push({ index: i, kind: "talk_over" });
  }
  return found;
}

const SYSTEM_PROMPT = `You judge candidate interruptions in an interview or podcast transcript. Each candidate shows \
the end of one speaker's turn, the words of the speaker who comes in next, and what follows. Speaker labels are \
letters assigned by diarization. For each candidate decide whether the second speaker interrupts the first.
It IS an interruption when the second speaker cuts in while the first is mid-thought or mid-sentence, takes the floor \
before the first has made their point, or talks over them with more than a polite acknowledgement.
It is NOT an interruption when it is a backchannel ("yeah", "right", "mm-hm", "sure") that lets the first speaker \
carry on, a short agreement or laugh that doesn't take the floor, or an ordinary hand-over after the first speaker \
finished. A dash at the end of a turn is a strong sign of being cut off, but check that the words that follow really \
break in rather than continue the sentence.
Write each reason in at most 15 words, without naming the speakers: call them "the first speaker" and "the second \
speaker" (the page puts their names in).
Give one verdict for every candidate id.`;

const Reply = z.object({
  verdicts: z.array(z.object({ id: z.number().int(), interruption: z.boolean(), reason: z.string() })),
});

const tail = (text: string, n: number) => (text.length > n ? `…${text.slice(-n)}` : text);
const head = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** One request judging a batch of candidates. */
async function judge(utterances: Utterance[], candidates: Candidate[]): Promise<Result<Interruption[]>> {
  const blocks = candidates.map(({ index, kind }, n) => {
    const prev = utterances[index - 1], cur = utterances[index], next = utterances[index + 1];
    const gap = (cur.start - prev.end).toFixed(2);
    return `#${n} (${kind === "cut_off" ? "previous turn ends unfinished" : "short interjection"}, gap ${gap}s)\n` +
      `${prev.speaker}: ${tail(prev.text, 220)}\n${cur.speaker}: ${head(cur.text, 220)}` +
      (next ? `\n${next.speaker}: ${head(next.text, 120)}` : "");
  });
  const { value, cost } = await ask({
    label: "interruptions", system: SYSTEM_PROMPT, schema: Reply, maxTokens: 8192, content: blocks.join("\n\n"),
  });
  if (!value) return { value: null, costs: [cost] };
  const found: Interruption[] = [];
  for (const v of value.verdicts) {
    const c = candidates[v.id];
    if (!c || !v.interruption) continue;
    const cur = utterances[c.index];
    found.push({
      index: c.index, by: cur.speaker, interrupted: utterances[c.index - 1].speaker, at: cur.start, kind: c.kind,
      reason: v.reason.trim().slice(0, 200),
    });
  }
  return { value: found, costs: [cost] };
}

export const interruptions: Analyzer<"interruptions"> = {
  key: "interruptions",
  version: 2, // 2: every candidate judged
  message: "finding interruptions...",
  async run(utterances) {
    const candidates = findCandidates(utterances);
    if (!candidates.length) return { value: [], costs: [] };
    if (!claudeAvailable()) return { value: null, costs: [] };
    const result = await inBatches(candidates, BATCH, batch => judge(utterances, batch), "interruptions");
    return { ...result, value: result.value?.sort((a, b) => a.index - b.index) ?? null };
  },
};
