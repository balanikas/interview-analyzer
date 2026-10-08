// Runs the analyzers over a transcript and saves what they found. Each analyzer is redone on its own: when it has no
// result yet (never run, or failed last time), or its result was made with an older version of it.

import { addCosts, assemblyAiCost } from "../cost.js";
import { HttpError } from "../net.js";
import type { RawTranscript } from "../providers/assemblyai.js";
import type { CostItem, TranscribeResponse } from "../shared/types.js";
import { readAnalysis, readRaw, toUtterances, writeAnalysis, type Analysis } from "../store/transcripts.js";
import type { Analyzer } from "./analyzer.js";
import { exchanges, judgeExchanges } from "./exchanges.js";
import { interruptions } from "./interruptions.js";
import { speakers } from "./speakers.js";

const ANALYZERS: Analyzer[] = [speakers, interruptions, exchanges];

type Log = (message: string) => void;

/** The transcript and its analysis as the page gets them, AssemblyAI's charge included. */
function response(name: string, raw: RawTranscript, analysis: Analysis): TranscribeResponse {
  const duration = raw.audio_duration ?? null;
  const items = [...(duration ? [assemblyAiCost(duration, raw.speech_model_used)] : []), ...(analysis.cost?.items ?? [])];
  return {
    file: name, duration, utterances: toUtterances(raw),
    ...(raw.speech_model_used && { speechModel: raw.speech_model_used }),
    ...(analysis.names && { names: analysis.names }),
    ...(analysis.interruptions && { interruptions: analysis.interruptions }),
    ...(analysis.exchanges && { exchanges: analysis.exchanges }),
    cost: addCosts(undefined, items),
  };
}

/** Works out whatever the saved analysis lacks or has out of date, saves it, and answers with the whole transcript. */
export async function analyze(name: string, raw: RawTranscript, log: Log): Promise<TranscribeResponse> {
  const utterances = toUtterances(raw);
  const analysis = await readAnalysis(name);
  const due = ANALYZERS.filter(a => analysis[a.key] === undefined || (analysis.versions?.[a.key] ?? 0) < a.version);
  const results = await Promise.all(due.map(a => {
    log(analysis[a.key] === undefined ? a.message : `${a.message} (again, with the current version)`);
    return a.run(utterances, analysis);
  }));

  const costs: CostItem[] = results.flatMap(r => r.costs);
  let changed = costs.length > 0;
  due.forEach((a, i) => {
    const value = results[i].value;
    if (value === null) return; // keeps an older result, if there is one, until a later try succeeds
    Object.assign(analysis, { [a.key]: value });
    analysis.versions = { ...analysis.versions, [a.key]: a.version };
    changed = true;
  });
  if (costs.length) analysis.cost = addCosts(analysis.cost, costs);
  if (changed) await writeAnalysis(name, analysis);
  return response(name, raw, analysis);
}

async function saved(file: string): Promise<{ raw: RawTranscript; analysis: Analysis }> {
  const raw = await readRaw(file);
  if (!raw) throw new HttpError("No transcript for that file yet.", 404);
  return { raw, analysis: await readAnalysis(file) };
}

/** Judges the exchanges again with the speakers a person marked as hosts, and saves them. */
export async function setHosts(file: string, hosts: string[]): Promise<TranscribeResponse> {
  const { raw, analysis } = await saved(file);
  const utterances = toUtterances(raw);
  const labels = new Set(utterances.map(u => u.speaker));
  const chosen = [...new Set(hosts)].filter(h => labels.has(h));
  if (!chosen.length) throw new HttpError("Mark at least one speaker as a host.", 400);
  if (chosen.length >= labels.size) throw new HttpError("At least one speaker has to be a guest.", 400);
  const { value, costs } = await judgeExchanges(utterances, chosen);
  if (costs.length) analysis.cost = addCosts(analysis.cost, costs);
  if (!value) {
    if (costs.length) await writeAnalysis(file, analysis);
    throw new HttpError("Couldn't judge the questions again. Try once more.");
  }
  analysis.exchanges = value;
  analysis.versions = { ...analysis.versions, exchanges: exchanges.version };
  await writeAnalysis(file, analysis);
  return response(file, raw, analysis);
}

/** Saves the names a person typed for a transcript's speakers, replacing the earlier ones; a blank name goes back to "Speaker X". */
export async function renameSpeakers(file: string, names: Record<string, string>): Promise<TranscribeResponse> {
  const { raw, analysis } = await saved(file);
  const labels = new Set((raw.utterances ?? []).map(u => u.speaker));
  analysis.names = Object.fromEntries(
    Object.entries(names)
      .map(([label, name]) => [label, name.trim().slice(0, 80)] as const)
      .filter(([label, name]) => labels.has(label) && name),
  );
  analysis.versions = { ...analysis.versions, names: speakers.version };
  await writeAnalysis(file, analysis);
  return response(file, raw, analysis);
}
