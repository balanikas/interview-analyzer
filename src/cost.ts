// Dollar cost of the third-party API calls behind one transcript. Claude's cost comes from the token counts in each
// response, priced at list rates. AssemblyAI's responses carry no cost, so its cost is estimated from the audio length.

import type { Cost, CostItem } from "./shared/types.js";

// USD per million tokens: input, output, cache write, cache read.
const CLAUDE_RATES: Record<string, [number, number, number, number]> = {
  "claude-sonnet-5-5": [2, 10, 2.5, 0.2],
  "claude-opus-5-5": [4, 20, 5, 0.4],
  "claude-haiku-4-5": [1, 5, 1.25, 0.1],
};
const DEFAULT_RATES = CLAUDE_RATES["claude-sonnet-5-5"];

// AssemblyAI list prices per audio hour: Universal transcription plus the speaker labels and language detection add-ons.
const ASSEMBLYAI_PER_HOUR = { transcription: 0.15, speaker_labels: 0.02, language_detection: 0.02 };

interface Usage { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }

export function claudeCost(label: string, model: string, usage: Usage): CostItem {
  const known = CLAUDE_RATES[model];
  const [inp, out, write, read] = known ?? DEFAULT_RATES;
  const usd = (usage.input_tokens * inp + usage.output_tokens * out +
    (usage.cache_creation_input_tokens ?? 0) * write + (usage.cache_read_input_tokens ?? 0) * read) / 1e6;
  return { service: "Claude", label, usd, estimated: !known };
}

export function assemblyAiCost(durationSeconds: number): CostItem {
  const perHour = Object.values(ASSEMBLYAI_PER_HOUR).reduce((a, b) => a + b, 0);
  return { service: "AssemblyAI", label: "transcription", usd: (durationSeconds / 3600) * perHour, estimated: true };
}

/** Adds items to a transcript's cost record, keeping the total in step. */
export function addCosts(cost: Cost | undefined, items: CostItem[]): Cost {
  const all = [...(cost?.items ?? []), ...items];
  return { total: all.reduce((sum, i) => sum + i.usd, 0), items: all };
}
