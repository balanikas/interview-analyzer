export interface AudioFile {
  name: string;
  size: number;
  /** Length in seconds; null when it can't be read from the file. */
  duration: number | null;
  /** Where the episode came from; null for files that weren't downloaded by download-audio.ts. */
  source: { show: string; publisher: string; title: string; url: string } | null;
  /** A transcript is already cached, so selecting the file won't send it to AssemblyAI again. */
  transcribed: boolean;
}

/** One continuous stretch of speech by one speaker, with times in seconds. */
export interface Utterance {
  /** AssemblyAI's diarization label: "A", "B", ... */
  speaker: string;
  start: number;
  end: number;
  text: string;
}

/** One speaker cutting in on another. */
export interface Interruption {
  /** Index in `utterances` of the utterance that cuts in. */
  index: number;
  /** Diarization label of the speaker who cuts in, and of the one who is cut in on. */
  by: string;
  interrupted: string;
  /** Seconds at which the interrupter starts. */
  at: number;
  /** cut_off: the other speaker's turn ends unfinished. talk_over: a short interjection into their turn. */
  kind: "cut_off" | "talk_over";
  /** Claude's one-line reason, written without names. */
  reason: string;
}

/** One host question and how the guest answered it. */
export interface Exchange {
  /** Index in `utterances` of the first utterance of the host's question. */
  index: number;
  /** Seconds at which the question starts. */
  at: number;
  /** How the host asked. */
  question: "open" | "closed" | "follow_up" | "challenge" | "softball";
  /** How the guest responded. */
  answer: "direct" | "partial" | "pivot" | "evasive";
  /** How much concrete content the answer has: facts, figures, named examples, specific stories. */
  density: "high" | "medium" | "low";
  /** Claude's one-line reason, written without names. */
  reason: string;
}

export interface Exchanges {
  /** Diarization label of the host: the speaker who asks the most questions. Empty when nobody asks any. */
  host: string;
  items: Exchange[];
}

/** One third-party API charge. */
export interface CostItem {
  service: "AssemblyAI" | "Claude";
  label: string;
  usd: number;
  /** True when the API didn't report the amount and it was worked out from list prices (always for AssemblyAI). */
  estimated: boolean;
}

export interface Cost {
  total: number;
  items: CostItem[];
}

export interface TranscribeResponse {
  file: string;
  duration: number | null;
  utterances: Utterance[];
  /** Real names by diarization label ("A" -> "Paul Runko"); a label without one is shown as "Speaker A". Missing until names have been worked out. */
  names?: Record<string, string>;
  /** Moments where one speaker cuts in on another; missing until they have been looked for. */
  interruptions?: Interruption[];
  /** The host's questions and how they were answered; missing until they have been judged. */
  exchanges?: Exchanges;
  /** What the API calls behind this transcript cost, in dollars. */
  cost?: Cost;
}

export interface RenameRequest {
  file: string;
  names: Record<string, string>;
}

export interface ErrorResponse {
  error: string;
}

/** One line of the NDJSON stream /api/transcribe answers with: progress messages, then the result or an error. */
export type TranscribeEvent =
  | { log: string }
  | { done: TranscribeResponse }
  | { error: string };
