// Interruptions: a clickable list, and the crosses the timeline draws for them. Both play from just before the cut-in.

import { hoursOf, interruptionContext, type InterruptionContext } from "../shared/scores.js";
import type { Interruption, TranscribeResponse } from "../shared/types.js";
import { $, h } from "./dom.js";
import { clock, nameOf } from "./format.js";
import { playMoment } from "./player.js";
import { on } from "./store.js";
import type { TimelineMarker } from "./timeline.js";

const LEAD_IN = 3;

const KIND_LABEL: Record<Interruption["kind"], string> = { cut_off: "cut off", talk_over: "talk-over" };
const CONTEXT_LABEL: Record<InterruptionContext, string> = {
  answer: "into an answer", dodge: "pressing a dodge", guest: "guest on host", other: "",
};

export const playInterruption = (i: Interruption) => playMoment(i.index, Math.max(i.at - LEAD_IN, 0), "list");

const summary = (data: TranscribeResponse, i: Interruption) =>
  `${nameOf(data, i.by)} ${i.kind === "cut_off" ? "cut off" : "talked over"} ${nameOf(data, i.interrupted)}`;

// Claude's reason calls the two "the first speaker" and "the second speaker" (older ones sometimes just "the first", or
// the diarization letter): their names go in here, so a renamed speaker shows up too.
const reasonOf = (data: TranscribeResponse, i: Interruption) => i.reason
  .replace(/\bSpeaker ([A-Z])\b/g, (_, label: string) => nameOf(data, label))
  .replace(/\b(?:the )?second speaker\b/gi, nameOf(data, i.by))
  .replace(/\b(?:the )?first speaker\b|\bthe first\b(?= (?:was|is|had|has|mid-))/gi, nameOf(data, i.interrupted));

/** The timeline's crosses, one per interruption, in the same order. */
export const markersOf = (data: TranscribeResponse): TimelineMarker[] => (data.interruptions ?? []).map(i => ({
  at: i.at, by: nameOf(data, i.by), interrupted: nameOf(data, i.interrupted),
  heading: `${clock(i.at)} · ${summary(data, i)}`, text: reasonOf(data, i) || KIND_LABEL[i.kind],
}));

on(["data"], ({ data }) => {
  const list = data?.interruptions;
  $("intbox").hidden = !list; // not judged (no API key, or the call failed): show nothing rather than "none"
  if (!data || !list) return;
  const hours = hoursOf(data);
  $("inttitle").textContent = `Interruptions (${list.length}${hours ? ` · ${(list.length / hours).toFixed(1)} per hour` : ""})`;
  if (!list.length) return void $("interruptions").replaceChildren(h("li", "none", "No interruptions found."));
  $("interruptions").replaceChildren(...list.map(i => {
    const context = interruptionContext(data, i);
    const li = h("li", "", h("span", "t", clock(i.at)), summary(data, i), h("span", "kind", KIND_LABEL[i.kind]),
                 ...(CONTEXT_LABEL[context] ? [h("span", `kind ${context}`, CONTEXT_LABEL[context])] : []),
                 h("span", "why", reasonOf(data, i)));
    li.addEventListener("click", () => playInterruption(i));
    return li;
  }));
});
