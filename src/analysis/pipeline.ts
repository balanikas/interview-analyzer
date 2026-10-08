// Runs the analyzers over a transcript and saves what they found. Each analyzer is redone on its own: when it has no
// result yet (never run, or failed last time), or its result was made with an older version of it. The intro and outro
// are found first, and the rest work on the utterances with those relabeled, so ad voices are never hosts or guests;
// when the intro or outro moves, the interruptions and exchanges are redone too.

import { addCosts, assemblyAiCost } from "../cost.js";
import { HttpError } from "../net.js";
import type { RawTranscript } from "../providers/assemblyai.js";
import { isFiller, labelSegments } from "../shared/segments.js";
import type { CostItem, Segments, TranscribeResponse, Utterance } from "../shared/types.js";
import { readAnalysis, readRaw, toUtterances, writeAnalysis, type Analysis } from "../store/transcripts.js";
import type { Analyzer } from "./analyzer.js";
import { exchanges, judgeExchanges } from "./exchanges.js";
import { interruptions } from "./interruptions.js";
import { segments } from "./segments.js";
import { speakers } from "./speakers.js";

const FIRST: Analyzer[] = [segments];
const THEN: Analyzer[] = [speakers, interruptions, exchanges];
/** Redone when the intro or outro moves (names aren't: a person may have typed them). */
const BY_SEGMENT: Analyzer[] = [interruptions, exchanges];

type Log = (message: string) => void;

/** The utterances as the analyzers and the page see them: the intro's and outro's relabeled. */
const utterancesOf = (raw: RawTranscript, analysis: Analysis): Utterance[] => labelSegments(toUtterances(raw), analysis.segments);

const sameSegments = (a: Segments | undefined, b: Segments | undefined, n: number) =>
  (a?.start ?? 0) === (b?.start ?? 0) && (a?.end ?? n) === (b?.end ?? n);

/** The transcript and its analysis as the page gets them, AssemblyAI's charge included. */
function response(name: string, raw: RawTranscript, analysis: Analysis): TranscribeResponse {
  const duration = raw.audio_duration ?? null;
  const items = [...(duration ? [assemblyAiCost(duration, raw.speech_model_used)] : []), ...(analysis.cost?.items ?? [])];
  return {
    file: name, duration, utterances: utterancesOf(raw, analysis),
    ...(analysis.segments && { segments: analysis.segments }),
    ...(raw.speech_model_used && { speechModel: raw.speech_model_used }),
    ...(analysis.names && { names: analysis.names }),
    ...(analysis.interruptions && { interruptions: analysis.interruptions }),
    ...(analysis.exchanges && { exchanges: analysis.exchanges }),
    cost: addCosts(undefined, items),
  };
}

/** Works out whatever the saved analysis lacks or has out of date, saves it, and answers with the whole transcript. */
export async function analyze(name: string, raw: RawTranscript, log: Log): Promise<TranscribeResponse> {
  const analysis = await readAnalysis(name);
  const before = analysis.segments;
  const first = await runDue(FIRST, toUtterances(raw), analysis, log);
  const moved = !sameSegments(before, analysis.segments, raw.utterances?.length ?? 0);
  const then = await runDue(THEN, utterancesOf(raw, analysis), analysis, log, a => moved && BY_SEGMENT.includes(a));

  const costs = [...first.costs, ...then.costs];
  if (costs.length) analysis.cost = addCosts(analysis.cost, costs);
  if (first.changed || then.changed || costs.length) await writeAnalysis(name, analysis);
  return response(name, raw, analysis);
}

/** Runs, side by side, the analyzers whose result is missing, out of date or `forced`, and puts what they found in `analysis`. */
async function runDue(analyzers: Analyzer[], utterances: Utterance[], analysis: Analysis, log: Log,
                      forced: (a: Analyzer) => boolean = () => false): Promise<{ costs: CostItem[]; changed: boolean }> {
  const due = analyzers.filter(a => analysis[a.key] === undefined || (analysis.versions?.[a.key] ?? 0) < a.version || forced(a));
  const results = await Promise.all(due.map(a => {
    log(analysis[a.key] === undefined ? a.message : `${a.message} (again, ${forced(a) ? "as the intro or outro moved" : "with the current version"})`);
    return a.run(utterances, analysis);
  }));
  let changed = false;
  due.forEach((a, i) => {
    const value = results[i].value;
    if (value === null) return; // keeps an older result, if there is one, until a later try succeeds
    Object.assign(analysis, { [a.key]: value });
    analysis.versions = { ...analysis.versions, [a.key]: a.version };
    changed = true;
  });
  return { costs: results.flatMap(r => r.costs), changed };
}

async function saved(file: string): Promise<{ raw: RawTranscript; analysis: Analysis }> {
  const raw = await readRaw(file);
  if (!raw) throw new HttpError("No transcript for that file yet.", 404);
  return { raw, analysis: await readAnalysis(file) };
}

/** Judges the exchanges again with the speakers a person marked as hosts, and saves them. */
export async function setHosts(file: string, hosts: string[]): Promise<TranscribeResponse> {
  const { raw, analysis } = await saved(file);
  const utterances = utterancesOf(raw, analysis);
  const labels = new Set(utterances.map(u => u.speaker).filter(s => !isFiller(s)));
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
