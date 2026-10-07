// Finds moments where one speaker cuts in on another. Diarization never reports two people talking at once, so the
// evidence is indirect: candidates are turns that end unfinished right before a speaker change (cut off), and short
// interjections inside someone else's turn (talk over). Claude then judges each candidate from its context.

import Anthropic from "@anthropic-ai/sdk";

import { claudeCost } from "./cost.js";
import type { CostItem, Interruption, Utterance } from "./shared/types.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const MAX_GAP = 0.5; // seconds between the end of one turn and the start of the next for it to count as a cut-in
const MAX_INTERJECTION_WORDS = 3;
const MAX_CANDIDATES = 250; // keeps one request small; the first ones in the recording are judged

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
  return found.slice(0, MAX_CANDIDATES);
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
Write each reason in at most 15 words, without naming the speakers (say "the second speaker" if needed).
Report your answer by calling the report_interruptions tool, with one verdict for every candidate id.`;

const TOOL: Anthropic.Tool = {
  name: "report_interruptions",
  description: "Report whether each candidate is a real interruption.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "integer" }, interruption: { type: "boolean" }, reason: { type: "string" } },
          required: ["id", "interruption", "reason"],
        },
      },
    },
    required: ["verdicts"],
  },
};

const tail = (text: string, n: number) => (text.length > n ? `…${text.slice(-n)}` : text);
const head = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Interruptions in a transcript; null when they couldn't be judged (no API key, API error), so a later view can retry. */
export async function detectInterruptions(utterances: Utterance[], costs: CostItem[]): Promise<Interruption[] | null> {
  const candidates = findCandidates(utterances);
  if (!candidates.length) return [];
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const blocks = candidates.map(({ index, kind }, n) => {
    const prev = utterances[index - 1], cur = utterances[index], next = utterances[index + 1];
    const gap = (cur.start - prev.end).toFixed(2);
    return `#${n} (${kind === "cut_off" ? "previous turn ends unfinished" : "short interjection"}, gap ${gap}s)\n` +
      `${prev.speaker}: ${tail(prev.text, 220)}\n${cur.speaker}: ${head(cur.text, 220)}` +
      (next ? `\n${next.speaker}: ${head(next.text, 120)}` : "");
  });
  try {
    const resp = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      messages: [{ role: "user", content: blocks.join("\n\n") }],
    });
    costs.push(claudeCost("interruptions", MODEL, resp.usage));
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const verdicts = (block?.input as { verdicts?: { id?: unknown; interruption?: unknown; reason?: unknown }[] } | undefined)?.verdicts;
    if (!Array.isArray(verdicts)) return null;
    const found: Interruption[] = [];
    for (const v of verdicts) {
      const c = typeof v.id === "number" ? candidates[v.id] : undefined;
      if (!c || v.interruption !== true) continue;
      const cur = utterances[c.index];
      found.push({
        index: c.index, by: cur.speaker, interrupted: utterances[c.index - 1].speaker, at: cur.start, kind: c.kind,
        reason: typeof v.reason === "string" ? v.reason.trim().slice(0, 200) : "",
      });
    }
    return found.sort((a, b) => a.index - b.index);
  } catch (e) {
    console.error("Couldn't judge interruptions:", e instanceof Error ? e.message : e);
    return null;
  }
}
