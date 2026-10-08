// One row per speaker: talk time and share, turns, average and longest turn, and interruptions.

import { speakerStats } from "../shared/scores.js";
import { $, h } from "./dom.js";
import { clock, nameOf, pct, speakerClasses } from "./format.js";
import { on } from "./store.js";

const HEADINGS = ["Speaker", "Talk time", "Share", "Turns", "Avg turn", "Longest turn", "Interrupted others", "Was interrupted"];

on(["data"], ({ data }) => {
  if (!data) return;
  const colour = speakerClasses(data);
  const cell = (text: string) => h("td", "", text);
  const count = (n: number | null) => cell(n === null ? "–" : String(n));
  const bar = (share: number) => {
    const fill = h("span");
    fill.style.width = pct(share);
    return h("div", "share", h("div", "bar", fill), pct(share));
  };
  $("stats").replaceChildren(
    h("tr", "", ...HEADINGS.map(text => h("th", "", text))),
    ...speakerStats(data).map(s => h("tr", "",
      h("td", "", h("div", "who", h("span", `spk ${colour(s.label)}`, s.label), h("span", "name", nameOf(data, s.label)))),
      cell(clock(s.seconds)), h("td", "", bar(s.share)), cell(String(s.turns)), cell(clock(s.seconds / s.turns)),
      cell(clock(s.longest)), count(s.interrupting), count(s.interrupted))),
  );
});
