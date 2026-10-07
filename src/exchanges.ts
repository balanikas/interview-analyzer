// Judges how the host's questions are asked and how the guest answers them. Diarization gives labels only, so the host
// is the speaker who asks the most questions; each exchange is one host question and the reply that follows it. Claude
// judges every exchange from its text alone.

import Anthropic from "@anthropic-ai/sdk";

import { claudeCost } from "./cost.js";
import type { CostItem, Exchange, Exchanges, Utterance } from "./shared/types.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const BATCH = 40; // exchanges per request; batches run in parallel
const MAX_EXCHANGES = 400; // bounds the cost of a very long recording
const MIN_QUESTION_WORDS = 4; // shorter host turns ("Right?", "Mm-hm.") are backchannels
const MIN_ANSWER_WORDS = 3;

const QUESTIONS: Exchange["question"][] = ["open", "closed", "follow_up", "challenge", "softball"];
const ANSWERS: Exchange["answer"][] = ["direct", "partial", "pivot", "evasive"];
const DENSITIES: Exchange["density"][] = ["high", "medium", "low"];

interface Turn { speaker: string; index: number; start: number; text: string }
interface Pair { question: Turn; answer: Turn; before: Turn | null }

const words = (text: string) => text.match(/\S+/g)?.length ?? 0;
const tail = (text: string, n: number) => (text.length > n ? `…${text.slice(-n)}` : text);
const head = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/** Consecutive utterances by one speaker joined into a single turn (the transcriber often splits one turn in several). */
function mergeTurns(utterances: Utterance[]): Turn[] {
  const turns: Turn[] = [];
  utterances.forEach((u, index) => {
    const last = turns.at(-1);
    if (last?.speaker === u.speaker) last.text += ` ${u.text}`;
    else turns.push({ speaker: u.speaker, index, start: u.start, text: u.text });
  });
  return turns;
}

/** The speaker with the most question turns; null when nobody asks any. */
export function findHost(turns: Turn[]): string | null {
  const asked = new Map<string, number>();
  for (const t of turns) if (t.text.includes("?") && words(t.text) >= MIN_QUESTION_WORDS) asked.set(t.speaker, (asked.get(t.speaker) ?? 0) + 1);
  return [...asked].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Host question turns, each with the turn that answers it and the turn before it. */
export function findExchanges(utterances: Utterance[]): { host: string; pairs: Pair[] } | null {
  const turns = mergeTurns(utterances);
  const host = findHost(turns);
  if (!host) return null;
  const pairs: Pair[] = [];
  turns.forEach((t, i) => {
    const answer = turns[i + 1];
    if (t.speaker !== host || !t.text.includes("?") || words(t.text) < MIN_QUESTION_WORDS) return;
    if (!answer || answer.speaker === host || words(answer.text) < MIN_ANSWER_WORDS) return;
    pairs.push({ question: t, answer, before: turns[i - 1] ?? null });
  });
  return { host, pairs: pairs.slice(0, MAX_EXCHANGES) };
}

const SYSTEM_PROMPT = `You judge the exchanges of an interview or podcast. Each exchange is a host's question and the \
guest's reply, with the end of the guest's previous answer for context. Judge from the text only; never use what you \
know about the people. For every exchange give four things.

question - how the host asked:
  follow_up: builds on something specific the guest just said (a topic that is merely related does not count)
  challenge: puts an objection, contradiction or inconvenient fact to the guest
  softball: invites the guest to say what they already want to say, or flatters them
  open: asks for explanation, story or opinion without leading
  closed: can be answered yes/no or with a short fact
  When several fit, prefer the first in the order follow_up, challenge, softball, open, closed.

answer - how the guest responded to what was asked:
  direct: addresses the question asked
  partial: addresses part of it, or answers only after a long detour
  pivot: answers a different question, or turns to the guest's own talking points
  evasive: says nothing checkable in reply to the question

density - how much concrete content the reply has (facts, figures, named examples, specific stories, reasoning), \
regardless of length: high, medium or low (generalities, repetition, filler).

Write each reason in at most 15 words, without naming the speakers (say "the host" and "the guest").
Report your answer by calling the report_exchanges tool, with one verdict for every exchange id.`;

const TOOL: Anthropic.Tool = {
  name: "report_exchanges",
  description: "Report how each question was asked and answered.",
  input_schema: {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer" },
            question: { type: "string", enum: QUESTIONS },
            answer: { type: "string", enum: ANSWERS },
            density: { type: "string", enum: DENSITIES },
            reason: { type: "string" },
          },
          required: ["id", "question", "answer", "density", "reason"],
        },
      },
    },
    required: ["verdicts"],
  },
};

const describe = ({ question, answer, before }: Pair, n: number) =>
  `#${n}\n` + (before ? `(previous answer ended: ${tail(before.text, 160)})\n` : "") +
  `HOST: ${tail(question.text, 450)}\nGUEST: ${head(answer.text, 450)}${answer.text.length > 450 ? ` … ${tail(answer.text, 200)}` : ""}`;

const oneOf = <T extends string>(allowed: readonly T[], v: unknown): v is T => typeof v === "string" && (allowed as readonly string[]).includes(v);

async function judge(pairs: Pair[], costs: CostItem[]): Promise<Exchange[] | null> {
  const resp = await new Anthropic().messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    messages: [{ role: "user", content: pairs.map(describe).join("\n\n") }],
  });
  costs.push(claudeCost("exchanges", MODEL, resp.usage));
  const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const verdicts = (block?.input as { verdicts?: Record<string, unknown>[] } | undefined)?.verdicts;
  if (!Array.isArray(verdicts)) return null;
  const found: Exchange[] = [];
  for (const v of verdicts) {
    const pair = typeof v.id === "number" ? pairs[v.id] : undefined;
    if (!pair || !oneOf(QUESTIONS, v.question) || !oneOf(ANSWERS, v.answer) || !oneOf(DENSITIES, v.density)) continue;
    found.push({
      index: pair.question.index, at: pair.question.start, question: v.question, answer: v.answer, density: v.density,
      reason: typeof v.reason === "string" ? v.reason.trim().slice(0, 200) : "",
    });
  }
  return found;
}

/** The judged exchanges of a transcript; null when they couldn't be judged (no API key, API error), so a later view can retry. */
export async function detectExchanges(utterances: Utterance[], costs: CostItem[]): Promise<Exchanges | null> {
  const found = findExchanges(utterances);
  if (!found || !found.pairs.length) return { host: found?.host ?? "", items: [] };
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const batches: Pair[][] = [];
  for (let i = 0; i < found.pairs.length; i += BATCH) batches.push(found.pairs.slice(i, i + BATCH));
  try {
    const results = await Promise.all(batches.map(b => judge(b, costs)));
    if (results.some(r => r === null)) return null;
    return { host: found.host, items: results.flatMap(r => r!).sort((a, b) => a.index - b.index) };
  } catch (e) {
    console.error("Couldn't judge exchanges:", e instanceof Error ? e.message : e);
    return null;
  }
}
