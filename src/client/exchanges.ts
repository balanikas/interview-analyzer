// Questions and answers: a host score and a guest score, then every exchange with its verdicts. Clicking a figure
// highlights its moments on the timeline; clicking an exchange plays from its question.

import { dodged, exchangeContaining, exchangeEnd, hoursOf, interruptionContext, replyIndices, thoughtful, type InterruptionContext } from "../shared/scores.js";
import type { Exchange, TranscribeResponse } from "../shared/types.js";
import { $, centerIn, h } from "./dom.js";
import { clock, pct } from "./format.js";
import { playMoment } from "./player.js";
import { on, set, state } from "./store.js";

// A scorecard figure: its value, and the utterances it highlights on the timeline when clicked.
interface Figure { label: string; tip: string; value: string; detail: string; indices: number[] }

function hostFigures(data: TranscribeResponse, items: Exchange[]): Figure[] {
  const hours = hoursOf(data);
  // Host interruptions of one kind, as a rate per hour; the interruptions themselves are highlighted.
  const perHour = (label: string, tip: string, context: InterruptionContext): Figure => {
    const hits = (data.interruptions ?? []).filter(i => interruptionContext(data, i) === context);
    return {
      label, tip, value: data.interruptions && hours ? (hits.length / hours).toFixed(1) : "–",
      detail: data.interruptions ? `${hits.length}, per hour` : "not judged", indices: hits.map(i => i.index),
    };
  };
  return [
    share(data, items, "Follow-up questions", "Questions that build on something specific the guest just said.", e => e.followUp, false),
    share(data, items, "Challenging follow-ups", "Follow-ups that also put an objection or inconvenient fact to the guest.", e => e.followUp && e.question === "challenge", false),
    share(data, items, "Challenging questions", "Questions that put an objection or inconvenient fact to the guest.", e => e.question === "challenge", false),
    share(data, items, "Thoughtful questions", "Open or challenging questions: not softballs, not yes/no.", thoughtful, false),
    perHour("Cut into answers", "A host cut in while the guest was answering the question. Lower is better.", "answer"),
    perHour("Pressed a dodge", "A host cut in while the guest pivoted or evaded. Pressure, not counted against the host.", "dodge"),
  ];
}

const guestFigures = (data: TranscribeResponse, items: Exchange[]): Figure[] => [
  share(data, items, "Direct answers", "Answers that address the question asked.", e => e.answer === "direct", true),
  share(data, items, "Non-answers", "Answers that pivot to another question or say nothing checkable. Lower is better.", dodged, true),
  share(data, items, "High-density answers", "Answers with plenty of facts, figures, examples or reasoning.", e => e.density === "high", true),
];

// A share of the exchanges: the questions themselves, or the guest's replies, are highlighted.
function share(data: TranscribeResponse, items: Exchange[], label: string, tip: string, test: (e: Exchange) => boolean, reply: boolean): Figure {
  const hits = items.flatMap((e, k) => (test(e) ? [{ e, k }] : []));
  return {
    label, tip, value: pct(hits.length / items.length), detail: `${hits.length} of ${items.length}`,
    indices: hits.flatMap(({ e, k }) => (reply ? replyIndices(data, k) : [e.index])),
  };
}

const figures = new Map<string, Figure>();

function renderScore(id: string, list: Figure[]): void {
  for (const f of list) figures.set(f.label, f);
  $(id).replaceChildren(...list.map(f => {
    const button = h("button", "", h("b", "", f.value), `${f.label} (${f.detail})`);
    button.type = "button";
    button.dataset.metric = f.label;
    button.title = `${f.tip} Click to highlight on the timeline.`;
    button.addEventListener("click", () => set({ metric: state().metric === f.label ? null : f.label }));
    return button;
  }));
}

const QUESTION_LABEL: Record<Exchange["question"], string> = { open: "open", closed: "closed", challenge: "challenge", softball: "softball" };
const ANSWER_LABEL: Record<Exchange["answer"], string> = { direct: "direct", partial: "partial", pivot: "pivot", evasive: "evasive" };

const tag = (text: string, cls = "") => h("span", `tag ${cls}`.trim(), text);

on(["data"], ({ data }) => {
  const items = data?.exchanges?.items;
  figures.clear();
  $("exbox").hidden = $("exlistbox").hidden = !items?.length; // not judged, or no host questions: show nothing rather than zeros
  if (data && items?.length) {
    renderScore("hostscore", hostFigures(data, items));
    renderScore("guestscore", guestFigures(data, items));
    $("exchanges").replaceChildren(...items.map((e, k) => {
      const li = h("li", "", h("span", "t", `${clock(e.at)}–${clock(exchangeEnd(data, k))}`), tag(QUESTION_LABEL[e.question], e.question === "challenge" ? "good" : ""),
                   ...(e.followUp ? [tag("follow-up", "good")] : []), tag(ANSWER_LABEL[e.answer], dodged(e) ? "bad" : ""),
                   tag(`${e.density} density`), h("span", "why", e.reason));
      li.addEventListener("click", () => playMoment(e.index, e.at, "list"));
      return li;
    }));
  }
  marked = null;
  markExchange(state().selection.index);
  highlight();
});

// The clicked figure's moments are highlighted on the timeline. Clicking it again clears it.
function highlight(): void {
  const { metric } = state();
  set({ highlight: new Set(metric ? figures.get(metric)?.indices : []) });
  for (const b of document.querySelectorAll<HTMLButtonElement>(".score button")) b.classList.toggle("on", b.dataset.metric === metric);
}
on(["metric"], highlight);

// Mark the exchange the selected utterance belongs to. Scrolls inside the list only.
let marked: number | null = null;
function markExchange(index: number | null): void {
  const k = exchangeContaining(state().data?.exchanges?.items ?? [], index);
  if (k === marked) return;
  marked = k;
  const list = $("exchanges");
  for (const li of list.querySelectorAll("li.cur")) li.classList.remove("cur");
  const li = k === null ? undefined : list.children[k] as HTMLElement | undefined;
  if (!li) return;
  li.classList.add("cur");
  centerIn(list, li);
}
on(["selection"], ({ selection }) => markExchange(selection.index));

// ---- The Exchanges tooltip: every label, styled as it appears in the lists, with what it means ----
// el is the element the label is drawn as: an exchange tag, or an interruption's context.
const LEGEND: { title: string; el: "tag" | "kind"; terms: [string, string, string?][] }[] = [
  { title: "How the host asked", el: "tag", terms: [
    ["open", "Asks for explanation, a story or an opinion, without leading the guest."],
    ["closed", "Can be answered with yes/no or a short fact."],
    ["challenge", "Puts an objection, contradiction or inconvenient fact to the guest.", "good"],
    ["softball", "Invites the guest to say what they already want to say, or flatters them."],
    ["follow-up", "Builds on something specific the guest just said. Marked on top of the type above, so a question can be a challenging follow-up.", "good"],
    ["thoughtful", "Open or challenge: not a softball, and not answerable with yes/no."],
  ] },
  { title: "How the guest answered", el: "tag", terms: [
    ["direct", "Addresses the question that was asked."],
    ["partial", "Addresses only part of it, or gets there after a long detour."],
    ["pivot", "Answers a different question, or turns to the guest's own talking points.", "bad"],
    ["evasive", "Says nothing checkable in reply to the question.", "bad"],
  ] },
  { title: "Density of the answer", el: "tag", terms: [
    ["high density", "Plenty of concrete content: facts, figures, named examples, specific stories or reasoning."],
    ["medium density", "Some concrete content mixed with generalities."],
    ["low density", "Mostly generalities, repetition or filler, however long the answer is."],
  ] },
  { title: "What an interruption cut into", el: "kind", terms: [
    ["into an answer", "A host cut in while the guest was answering the question (direct or partial answer). Counts against the host.", "answer"],
    ["pressing a dodge", "A host cut in while the guest was pivoting or evading. Pressure, not counted against the host.", "dodge"],
    ["guest on host", "The guest cut in on a host.", "guest"],
  ] },
];

$("legend").append(...LEGEND.map(group => h("div", "", h("h3", "", group.title),
  ...group.terms.flatMap(([term, tip, cls = ""]) => [h("span", `${group.el} ${cls}`.trim(), term), h("span", "", tip)]))));
