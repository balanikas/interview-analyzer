/** Where an audio file came from: the show and episode page for a podcast, or the pasted link. */
export interface AudioSource {
  show: string;
  publisher: string;
  title: string;
  url: string;
}

export interface AudioFile {
  name: string;
  size: number;
  /** Length in seconds; null when it can't be read from the file. */
  duration: number | null;
  /** Where the episode came from; null for files put in the folder by hand. */
  source: AudioSource | null;
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
  /**
   * What the interrupted speaker was doing before the cut, judged from their words up to it: answering what they were
   * asked, dodging it, or neither. Missing for interruptions judged before it was recorded.
   */
  during?: "answer" | "dodge" | "other";
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
  question: "open" | "closed" | "challenge" | "softball";
  /** The question builds on something specific the guest just said; independent of `question`, so a follow-up can also be a challenge. */
  followUp: boolean;
  /** How the guest responded. */
  answer: "direct" | "partial" | "pivot" | "evasive";
  /** How much concrete content the answer has: facts, figures, named examples, specific stories. */
  density: "high" | "medium" | "low";
  /** Claude's one-line reason, written without names. */
  reason: string;
}

export interface Exchanges {
  /** Diarization labels of the hosts: the speaker who asks the most questions and anyone who asks nearly as many, or the
   *  speakers a person marked. Empty when nobody asks any. */
  hosts: string[];
  /** True when a person picked the hosts, so re-analysis keeps them. */
  manual?: boolean;
  items: Exchange[];
}

/**
 * Where the interview itself runs, as utterance indices: the utterances before `start` are the intro (ads, show
 * promotion, announcements by voices other than the interview's speakers) and those from `end` on are the outro.
 */
export interface Segments {
  start: number;
  end: number;
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
  /** The intro's and outro's utterances carry the speaker "Intro" and "Outro" in place of their diarization label. */
  utterances: Utterance[];
  /** Where the intro ends and the outro starts; missing until they have been looked for. */
  segments?: Segments;
  /** AssemblyAI model that transcribed it ("universal-3-5-pro", or "universal-2" for languages that model lacks). Missing for transcripts saved before it was recorded. */
  speechModel?: string;
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

/** The speakers a person marked as hosts; the exchanges are judged again with them. */
export interface HostsRequest {
  file: string;
  hosts: string[];
}

export interface ErrorResponse {
  error: string;
}

/** POST /api/jobs: analyze a pasted link, or a file already downloaded. */
export type JobRequest = { audio_url: string } | { file: string };

/** A transcription job. Its progress is followed at /api/jobs/:id/events. */
export interface JobInfo {
  id: string;
  file: string;
}

/** One server-sent event of a job: a progress message, then the result or an error. */
export type JobEvent =
  | { log: string }
  | { done: TranscribeResponse }
  | { error: string };
