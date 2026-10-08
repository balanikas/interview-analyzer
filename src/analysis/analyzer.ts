// What every analysis step looks like to the pipeline, and the batching the Claude-judged ones share.

import type { CostItem, Utterance } from "../shared/types.js";
import type { Analysis, AnalysisKey } from "../store/transcripts.js";

export interface Result<T> {
  /** Null when it couldn't be worked out (no API key, an API error); the pipeline tries again next time. */
  value: T | null;
  costs: CostItem[];
}

export interface Analyzer<K extends AnalysisKey = AnalysisKey> {
  key: K;
  /** Bumped when the analyzer changes in a way that makes its saved results out of date. */
  version: number;
  /** Logged as the work starts. */
  message: string;
  run(utterances: Utterance[], prior: Analysis): Promise<Result<NonNullable<Analysis[K]>>>;
}

/**
 * Judges `items` in batches of `size`, all in parallel, and joins the results in order. Null when any batch fails (the
 * whole result would have holes); the costs of the batches that did run are kept either way.
 */
export async function inBatches<I, O>(items: I[], size: number, judge: (batch: I[]) => Promise<Result<O[]>>,
                                      what: string): Promise<Result<O[]>> {
  const batches: I[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const settled = await Promise.allSettled(batches.map(judge));
  const costs = settled.flatMap(s => (s.status === "fulfilled" ? s.value.costs : []));
  const failed = settled.find(s => s.status === "rejected");
  if (failed) console.error(`Couldn't judge ${what}:`, failed.reason instanceof Error ? failed.reason.message : failed.reason);
  if (settled.some(s => s.status === "rejected" || s.value.value === null)) return { value: null, costs };
  return { value: settled.flatMap(s => (s.status === "fulfilled" ? s.value.value! : [])), costs };
}
