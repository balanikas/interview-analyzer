// Judges how the host's questions are asked and how the guest answers them. Diarization gives labels only, so the hosts
// are the speaker who asks the most questions and anyone who asks nearly as many (a panel), unless a person marked them;
// each exchange is one host turn and the guest reply that follows it. A host turn need not be phrased as a question: hosts
// press with statements ("That's not how the process works."), so any host turn the guest answers at length is a
// candidate, and Claude drops the ones that don't invite a reply. Claude judges every exchange from its text alone.

import { z } from "zod";

import { ask, claudeAvailable } from "../providers/claude.js";
import { isFiller } from "../shared/segments.js";
import type { Exchange, Exchanges, Utterance } from "../shared/types.js";
import { inBatches, type Analyzer, type Result } from "./analyzer.js";

const BATCH = 40; // exchanges per request; batches run in parallel
const MAX_EXCHANGES = 400; // bounds the cost of a very long recording
const MIN_QUESTION_WORDS = 4; // shorter host turns ("Right?", "Mm-hm.") are backchannels
const MIN_ANSWER_WORDS = 3;
// A host statement without a question mark needs a substantial reply to count: short ones are usually just agreement.
const MIN_STATEMENT_ANSWER_WORDS = 15;
// A second questioner counts as a co-host only when they ask at least half as many questions as the main host, and at
// least a few: guests in heated interviews ask questions back, and those must not make them hosts.
const CO_HOST_SHARE = 0.5;
const MIN_CO_HOST_QUESTIONS = 3;

const QUESTIONS = ["open", "closed", "challenge", "softball"] as const satisfies readonly Exchange["question"][];
const ANSWERS = ["direct", "partial", "pivot", "evasive"] as const satisfies readonly Exchange["answer"][];
const DENSITIES = ["high", "medium", "low"] as const satisfies readonly Exchange["density"][];

interface Turn { speaker: string; index: number; start: number; text: string }
interface Pair { question: Turn; answer: Turn; before: Turn | null }

const words = (text: string) => text.match(/\S+/g)?.length ?? 0;
const tail = (text: string, n: number) => (text.length > n ? `…${text.slice(-n)}` : text);
const head = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text);

/**
 * Consecutive utterances by one speaker joined into a single turn (the transcriber often splits one turn in several).
 * The intro and outro are left out: they ask nothing of the guest.
 */
function mergeTurns(utterances: Utterance[]): Turn[] {
  const turns: Turn[] = [];
  utterances.forEach((u, index) => {
    if (isFiller(u.speaker)) return;
    const last = turns.at(-1);
    if (last?.speaker === u.speaker) last.text += ` ${u.text}`;
    else turns.push({ speaker: u.speaker, index, start: u.start, text: u.text });
  });
  return turns;
}

const isQuestion = (t: Turn) => t.text.includes("?") && words(t.text) >= MIN_QUESTION_WORDS;

/** The speaker with the most question turns, plus any co-host who asks nearly as many; empty when nobody asks any. */
export function findHosts(turns: Turn[]): string[] {
  const asked = new Map<string, number>();
  for (const t of turns) if (isQuestion(t)) asked.set(t.speaker, (asked.get(t.speaker) ?? 0) + 1);
  const ranked = [...asked].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return [];
  const top = ranked[0][1];
  const hosts = ranked.filter(([, n], i) => i === 0 || (n >= top * CO_HOST_SHARE && n >= MIN_CO_HOST_QUESTIONS)).map(([s]) => s);
  // Somebody has to be left to answer.
  const speakers = new Set(turns.map(t => t.speaker));
  return hosts.length < speakers.size ? hosts : hosts.slice(0, 1);
}

/** Host turns that ask or press the guest, each with the guest turn that answers it and the turn before it. */
export function findExchanges(utterances: Utterance[], chosen?: string[]): { hosts: string[]; pairs: Pair[] } {
  const turns = mergeTurns(utterances);
  const hosts = chosen ?? findHosts(turns);
  const isHost = (t: Turn | undefined) => !!t && hosts.includes(t.speaker);
  const pairs: Pair[] = [];
  turns.forEach((t, i) => {
    const answer = turns[i + 1];
    if (!isHost(t) || words(t.text) < MIN_QUESTION_WORDS) return;
    if (!answer || isHost(answer)) return;
    if (words(answer.text) < (isQuestion(t) ? MIN_ANSWER_WORDS : MIN_STATEMENT_ANSWER_WORDS)) return;
    pairs.push({ question: t, answer, before: turns[i - 1] ?? null });
  });
  return { hosts, pairs: pairs.slice(0, MAX_EXCHANGES) };
}

const SYSTEM_PROMPT = `You judge the exchanges of an interview or podcast. Each exchange is a host's turn and the \
guest's reply, with the end of the guest's previous answer for context. The host's turn may be a question or a \
statement that presses the guest. Judge from the text only; never use what you know about the people. For every \
exchange give six things.

prompt - true when the host's turn asks for or presses for a reply, including a statement that challenges, corrects \
or asks the guest to respond; false when it doesn't (agreement, thanks, a sign-off, an aside the guest talks past). \
Exchanges with prompt false are discarded, but still give the other fields.

question - how the host asked:
  challenge: puts an objection, contradiction or inconvenient fact to the guest
  softball: invites the guest to say what they already want to say, or flatters them
  open: asks for explanation, story or opinion without leading
  closed: can be answered yes/no or with a short fact
  When several fit, prefer the first in the order challenge, softball, open, closed.

follow_up - true when the question builds on something specific the guest just said (a topic that is merely related \
does not count), false otherwise. This is separate from question: a follow-up can be a challenge, open, and so on.

answer - how the guest responded to what was asked:
  direct: addresses the question asked
  partial: addresses part of it, or answers only after a long detour
  pivot: answers a different question, or turns to the guest's own talking points
  evasive: says nothing checkable in reply to the question

density - how much concrete content the reply has (facts, figures, named examples, specific stories, reasoning), \
regardless of length: high, medium or low (generalities, repetition, filler).

Write each reason in at most 15 words, without naming the speakers (say "the host" and "the guest").
Give one verdict for every exchange id.`;

const Reply = z.object({
  verdicts: z.array(z.object({
    id: z.number().int(),
    prompt: z.boolean(),
    question: z.enum(QUESTIONS),
    follow_up: z.boolean(),
    answer: z.enum(ANSWERS),
    density: z.enum(DENSITIES),
    reason: z.string(),
  })),
});

const describe = ({ question, answer, before }: Pair, n: number) =>
  `#${n}\n` + (before ? `(previous answer ended: ${tail(before.text, 160)})\n` : "") +
  `HOST: ${tail(question.text, 450)}\nGUEST: ${head(answer.text, 450)}${answer.text.length > 450 ? ` … ${tail(answer.text, 200)}` : ""}`;

async function judge(pairs: Pair[]): Promise<Result<Exchange[]>> {
  const { value, cost } = await ask({
    label: "exchanges", system: SYSTEM_PROMPT, schema: Reply, maxTokens: 4096, content: pairs.map(describe).join("\n\n"),
  });
  if (!value) return { value: null, costs: [cost] };
  const found: Exchange[] = [];
  for (const v of value.verdicts) {
    const pair = pairs[v.id];
    if (!pair || !v.prompt) continue;
    found.push({
      index: pair.question.index, at: pair.question.start, question: v.question, followUp: v.follow_up,
      answer: v.answer, density: v.density, reason: v.reason.trim().slice(0, 200),
    });
  }
  return { value: found, costs: [cost] };
}

/** The judged exchanges of a transcript, with the hosts a person chose or else the ones worked out from the questions. */
export async function judgeExchanges(utterances: Utterance[], chosen?: string[]): Promise<Result<Exchanges>> {
  const found = findExchanges(utterances, chosen);
  const manual = chosen ? { manual: true } : {};
  if (!found.pairs.length) return { value: { hosts: found.hosts, ...manual, items: [] }, costs: [] };
  if (!claudeAvailable()) return { value: null, costs: [] };
  const result = await inBatches(found.pairs, BATCH, judge, "exchanges");
  const items = result.value?.sort((a, b) => a.index - b.index);
  return { value: items ? { hosts: found.hosts, ...manual, items } : null, costs: result.costs };
}

export const exchanges: Analyzer<"exchanges"> = {
  key: "exchanges",
  version: 3, // 2: follow-up is a flag next to the question type, several hosts; 3: host statements count as prompts
  message: "finding exchanges and tagging...",
  // Hosts a person picked outlive re-analysis.
  run: (utterances, prior) => judgeExchanges(utterances, prior.exchanges?.manual ? prior.exchanges.hosts : undefined),
};
