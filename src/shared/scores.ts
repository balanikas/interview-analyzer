// The interview judged against the standard in two separate scores: how the host asks (follow-ups, challenges,
// thoughtful questions, not cutting into answers) and how the guest answers (directly, with substance). Kept apart so
// an evasive guest doesn't count against a good host, or a soft host get credit for a forthcoming guest. Everything is
// a rate, so a ten-minute segment and a three-hour podcast compare fairly.
// Pure functions of a transcript and its analysis, shared by the server and the page: no DOM, no Node.

import { isFiller } from "./segments.js";
import type { Exchange, Interruption, TranscribeResponse, Utterance } from "./types.js";

/**
 * What an interruption cut into. answer: a host cut into a guest's real answer (counts against the host). dodge: a host
 * pressed a guest who was pivoting or evading (pressure, not counted against them). guest: a guest cut in on a host.
 * other: anything else, such as two guests, or before the first question.
 */
export type InterruptionContext = "answer" | "dodge" | "guest" | "other";

/** The exchange whose reply an utterance belongs to: the last question before it, up to the next question. */
function exchangeAnswering(items: Exchange[], index: number): Exchange | undefined {
  let found: Exchange | undefined;
  for (const e of items) if (e.index < index) found = e; else break;
  return found;
}

/** Position in `items` of the exchange an utterance is part of: from its question up to the next question. */
export function exchangeContaining(items: Exchange[], index: number | null): number | null {
  let k: number | null = null;
  if (index !== null) for (let j = 0; j < items.length && items[j].index <= index; j++) k = j;
  return k;
}

export function interruptionContext(data: TranscribeResponse, i: Interruption): InterruptionContext {
  const hosts = data.exchanges?.hosts ?? [];
  const byHost = hosts.includes(i.by), onHost = hosts.includes(i.interrupted);
  if (!byHost) return onHost ? "guest" : "other";
  if (onHost) return "other";
  const e = exchangeAnswering(data.exchanges?.items ?? [], i.index);
  if (!e) return "other";
  return dodged(e) ? "dodge" : "answer";
}

/** Length of the interview in hours, for rates per hour: the recording without its intro and outro. */
export function hoursOf(data: TranscribeResponse): number {
  const u = data.utterances, s = data.segments;
  if (s && s.start < s.end && (s.start > 0 || s.end < u.length)) return (u[s.end - 1].end - u[s.start].start) / 3600;
  return (data.duration ?? Math.max(0, ...u.map(u => u.end))) / 3600;
}

/** A question that leads somewhere: open-ended or challenging, not a softball and not yes/no. */
export const thoughtful = (e: Exchange): boolean => e.question === "open" || e.question === "challenge";

export const dodged = (e: Exchange): boolean => e.answer === "pivot" || e.answer === "evasive";

/** The guest's reply to the k-th exchange: the non-host utterances after its question, up to the next question. */
export function replyIndices(data: TranscribeResponse, k: number): number[] {
  const items = data.exchanges?.items ?? [];
  const hosts = new Set(data.exchanges?.hosts ?? []);
  const stop = items[k + 1]?.index ?? data.utterances.length, out: number[] = [];
  for (let i = items[k].index + 1; i < stop; i++) {
    const { speaker } = data.utterances[i];
    if (!hosts.has(speaker) && !isFiller(speaker)) out.push(i);
  }
  return out;
}

/** Seconds at which the k-th exchange ends: the end of the guest turn that answers its question, as it was judged. */
export function exchangeEnd(data: TranscribeResponse, k: number): number {
  const u = data.utterances;
  let i = data.exchanges!.items[k].index;
  const sameTurn = (speaker: string) => { while (i + 1 < u.length && u[i + 1].speaker === speaker) i++; };
  sameTurn(u[i].speaker); // the rest of the question
  if (i + 1 < u.length) { i++; sameTurn(u[i].speaker); } // the reply
  return u[i].end;
}

/** Diarization labels in order of first appearance; the intro and outro aren't speakers. */
export function speakerOrder(utterances: Utterance[]): string[] {
  return [...new Set(utterances.map(u => u.speaker).filter(s => !isFiller(s)))];
}

export interface SpeakerStats {
  label: string;
  /** Seconds of speech, and its share of all speech. */
  seconds: number;
  share: number;
  turns: number;
  longest: number;
  /** Interruptions by this speaker and of them; null when interruptions weren't judged. */
  interrupting: number | null;
  interrupted: number | null;
}

/** One entry per speaker, in order of first appearance. */
export function speakerStats(data: TranscribeResponse): SpeakerStats[] {
  const rows = speakerOrder(data.utterances).map(label => {
    const mine = data.utterances.filter(u => u.speaker === label);
    return {
      label,
      seconds: mine.reduce((t, u) => t + (u.end - u.start), 0),
      turns: mine.length,
      longest: Math.max(...mine.map(u => u.end - u.start)),
      interrupting: data.interruptions ? data.interruptions.filter(i => i.by === label).length : null,
      interrupted: data.interruptions ? data.interruptions.filter(i => i.interrupted === label).length : null,
    };
  });
  const total = rows.reduce((t, s) => t + s.seconds, 0) || 1;
  return rows.map(r => ({ ...r, share: r.seconds / total }));
}
