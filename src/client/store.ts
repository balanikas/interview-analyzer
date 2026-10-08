// The page's state in one place. Panels subscribe to the parts they show and redraw themselves when those change, so
// an action (clicking a line, the audio moving on) only says what changed, not which views to update.

import type { AudioFile, TranscribeResponse } from "../shared/types.js";

/** What moved the selection; it decides what scrolls to follow it (never the view that was clicked). */
export type SelectionSource = "transcript" | "timeline" | "player" | "list";

export interface State {
  /** The transcript on show. */
  data: TranscribeResponse | null;
  /** The utterance marked in the transcript and on the timeline. */
  selection: { index: number | null; from: SelectionSource };
  /** The scorecard figure last clicked, and the utterances it highlights on the timeline. */
  metric: string | null;
  highlight: ReadonlySet<number>;
  /** Playback position in seconds. */
  time: number;
  /** A job is running: the Analyze button and the picker are disabled. */
  busy: boolean;
  /** The downloaded audio. */
  files: AudioFile[];
}

type Key = keyof State;

let current: State = {
  data: null, selection: { index: null, from: "player" }, metric: null, highlight: new Set(), time: 0, busy: false, files: [],
};
const subscribers: { keys: ReadonlySet<Key>; fn: (s: Readonly<State>) => void }[] = [];

export const state = (): Readonly<State> => current;

/** Calls `fn` whenever one of `keys` changes. */
export function on(keys: Key[], fn: (s: Readonly<State>) => void): void {
  subscribers.push({ keys: new Set(keys), fn });
}

export function set(patch: Partial<State>): void {
  const changed = (Object.keys(patch) as Key[]).filter(k => patch[k] !== current[k]);
  if (!changed.length) return;
  current = { ...current, ...patch };
  for (const s of subscribers) if (changed.some(k => s.keys.has(k))) s.fn(current);
}
