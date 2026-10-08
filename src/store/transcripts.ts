// The transcript caches, both keyed by audio file name: AssemblyAI's raw response (paid for, never redone) and the
// analysis worked out from it (redone per analyzer when that analyzer's version moves on).

import { access } from "node:fs/promises";

import { paths } from "../config.js";
import type { RawTranscript } from "../providers/assemblyai.js";
import type { Cost, Exchanges, Interruption, Utterance } from "../shared/types.js";
import { fileIn, readJson, writeJson } from "./json.js";

/** What the app worked out from a transcript. */
export interface Analysis {
  /** The version of each analyzer its result was made with; an older one is redone when the transcript is opened. */
  versions?: Partial<Record<AnalysisKey, number>>;
  names?: Record<string, string>;
  interruptions?: Interruption[];
  exchanges?: Exchanges;
  /** The Claude calls behind it; AssemblyAI's charge is worked out from the raw transcript. */
  cost?: Cost;
}

export type AnalysisKey = "names" | "interruptions" | "exchanges";

const rawPath = (name: string) => fileIn(paths.raw, name, ".json");
const analysisPath = (name: string) => fileIn(paths.analysis, name, ".json");

export const readRaw = (name: string) => readJson<RawTranscript>(rawPath(name));
export const writeRaw = (name: string, raw: RawTranscript) => writeJson(rawPath(name), raw);
export const hasRaw = (name: string) => access(rawPath(name)).then(() => true, () => false);

export const readAnalysis = async (name: string): Promise<Analysis> => (await readJson<Analysis>(analysisPath(name))) ?? {};
export const writeAnalysis = (name: string, analysis: Analysis) => writeJson(analysisPath(name), analysis);

export const toUtterances = (raw: RawTranscript): Utterance[] => (raw.utterances ?? []).map(u => ({
  speaker: u.speaker, start: u.start / 1000, end: u.end / 1000, text: u.text,
}));
