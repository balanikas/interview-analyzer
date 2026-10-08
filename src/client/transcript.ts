// The transcript: one line per utterance. Clicking a line plays from it; the selected line follows the audio.

import { $, centerIn, h } from "./dom.js";
import { clock, nameOf, speakerClasses } from "./format.js";
import { playMoment } from "./player.js";
import { on } from "./store.js";

const lines = $("tlines");

on(["data"], ({ data }) => {
  if (!data) return;
  const colour = speakerClasses(data);
  lines.replaceChildren(...data.utterances.map((u, i) => {
    const li = h("li", "", h("span", "t", clock(u.start)), h("span", `spk ${colour(u.speaker)}`, nameOf(data, u.speaker)), u.text);
    li.addEventListener("click", () => playMoment(i, u.start, "transcript"));
    return li;
  }));
  $("transcript").scrollTop = 0;
});

// The clicked line stays where it is; anything else scrolls the selected line into the middle of the panel.
on(["selection"], ({ selection: { index, from } }) => {
  for (const li of lines.querySelectorAll("li.cur")) li.classList.remove("cur");
  const li = index === null ? undefined : lines.children[index] as HTMLElement | undefined;
  li?.classList.add("cur");
  if (li && from !== "transcript") centerIn($("transcript"), li);
});
