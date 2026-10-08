// Puts the speaker timeline on the page and keeps it in step: selection, playhead, highlighted moments, interruptions.

import { $ } from "./dom.js";
import { nameOf } from "./format.js";
import { markersOf, playInterruption } from "./interruptions.js";
import { playMoment, seek } from "./player.js";
import { on } from "./store.js";
import { renderTimeline, type TimelineControl } from "./timeline.js";

let control: TimelineControl | null = null;

on(["data"], s => {
  const { data } = s;
  if (!data?.utterances.length) return;
  const end = Math.max(...data.utterances.map(u => u.end));
  control = renderTimeline($("speechline") as unknown as SVGSVGElement, $("speechlabels") as unknown as SVGSVGElement,
                           data.utterances, { start: 0, end }, label => nameOf(data, label),
                           i => playMoment(i, data.utterances[i].start, "timeline"), seek);
  control.setMarkers(markersOf(data), n => playInterruption(data.interruptions![n]));
  control.select(s.selection.index, false);
  control.setTime(s.time);
  control.setHighlight(s.highlight);
});

// Scrolls to the selected bar only when it was picked by hand; when the audio moves on, the playhead scrolls instead.
on(["selection"], ({ selection: { index, from } }) => control?.select(index, from === "transcript" || from === "timeline"));
on(["time"], ({ time }) => control?.setTime(time));
on(["highlight"], ({ highlight }) => control?.setHighlight(highlight));
