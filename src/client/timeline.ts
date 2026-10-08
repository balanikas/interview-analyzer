// Speaker timeline: one row per speaker, time left to right, one bar per stretch of speech.

import { isFiller } from "../shared/segments.js";
import type { Utterance } from "../shared/types.js";
import { clock } from "./format.js";

const ROW_H = 32;
const LEFT = 8; // gap before time 0; the speaker names live in their own fixed column
const LABEL_W = 130;
const TOP = 26;
const RIGHT = 24;
const NS = "http://www.w3.org/2000/svg";

type Attrs = Record<string, string | number>;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Attrs, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.append(node);
  return node;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

interface TipContent { heading: string; text: string }

// One shared tooltip, positioned next to the pointer (or the focused bar) and kept inside the window.
// Long text is cut off with a fade; the full text is a click away in the transcript.
const tip = (() => {
  let box: HTMLDivElement | null = null;
  const parts = () => {
    if (!box) {
      box = document.createElement("div");
      box.id = "tip";
      box.setAttribute("role", "tooltip");
      box.hidden = true;
      box.innerHTML = '<div class="tip-head"></div><div class="tip-body"></div><div class="tip-foot"></div>';
      document.body.append(box);
    }
    const q = (sel: string) => box!.querySelector(sel) as HTMLElement;
    return { box, head: q(".tip-head"), body: q(".tip-body"), foot: q(".tip-foot") };
  };
  return {
    show(content: TipContent, clientX: number, clientY: number) {
      const { box, head, body, foot } = parts();
      head.textContent = content.heading;
      body.textContent = content.text;
      box.hidden = false;
      const clipped = body.scrollHeight > body.clientHeight;
      body.classList.toggle("clipped", clipped);
      foot.textContent = "Click to read it all in the transcript.";
      foot.hidden = !clipped;
      tip.move(clientX, clientY);
    },
    move(clientX: number, clientY: number) {
      const { box } = parts();
      const gap = 14, w = box.offsetWidth, h = box.offsetHeight;
      const left = clientX + gap + w > innerWidth ? Math.max(clientX - gap - w, 4) : clientX + gap;
      const top = clientY + gap + h > innerHeight ? Math.max(clientY - gap - h, 4) : clientY + gap;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
    },
    hide() { if (box) box.hidden = true; },
  };
})();

/** The time range the timeline spans. */
export interface Domain { start: number; end: number }

const scaleFor = (d: Domain) => {
  const span = Math.max(d.end - d.start, 1);
  const pxPerSec = Math.min(Math.max(1400 / span, 0.25), 8);
  return { span, pxPerSec, x: (sec: number) => LEFT + (sec - d.start) * pxPerSec };
};

// Rows, row labels and the time axis. Returns the y of a speaker's row centre.
function drawFrame(svg: SVGSVGElement, labels: SVGSVGElement, speakers: string[], d: Domain): (name: string) => number {
  const { span, x } = scaleFor(d);
  const width = x(d.end) + RIGHT;
  const height = TOP + speakers.length * ROW_H + 24;
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  labels.replaceChildren();
  labels.setAttribute("width", String(LABEL_W));
  labels.setAttribute("height", String(height));
  speakers.forEach((name, r) => {
    const y = TOP + r * ROW_H;
    if (r % 2 === 0) el("rect", { class: "band", x: 0, y, width, height: ROW_H }, svg);
    if (r % 2 === 0) el("rect", { class: "band", x: 0, y, width: LABEL_W, height: ROW_H }, labels);
    el("text", { class: "who", x: 4, y: y + ROW_H / 2 }, labels).textContent = clip(name, 18);
  });
  const tick = [30, 60, 120, 300, 600, 900, 1800, 3600].find(t => span / t <= 14) ?? 3600;
  for (let t = Math.ceil(d.start / tick) * tick; t <= d.end; t += tick) {
    el("line", { class: "grid", x1: x(t), y1: TOP, x2: x(t), y2: height - 20 }, svg);
    el("text", { class: "axis", x: x(t), y: height - 6 }, svg).textContent = clock(t);
  }
  return name => TOP + speakers.indexOf(name) * ROW_H + ROW_H / 2;
}

/** A cross on the interrupter's row, linked to the row of the speaker who was cut in on. */
export interface TimelineMarker {
  at: number;
  /** Row names (the speakers' display names). */
  by: string;
  interrupted: string;
  heading: string;
  text: string;
}

export interface TimelineControl {
  /** Replace the interruption markers; `onClick` gets the marker's index. */
  setMarkers(markers: TimelineMarker[], onClick: (index: number) => void): void;
  /** Mark one bar as selected (null clears it), and by default scroll it into view. */
  select(index: number | null, scroll?: boolean): void;
  /** Emphasise these bars and fade the rest (null or empty clears it). */
  setHighlight(indices: ReadonlySet<number> | null): void;
  /** Move the playhead to a time in seconds (null hides it), scrolling sideways when it leaves the view. */
  setTime(seconds: number | null): void;
}

// One bar per utterance, on its speaker's row.
export function renderTimeline(svg: SVGSVGElement, labels: SVGSVGElement, utterances: Utterance[], domain: Domain,
                               nameOf: (label: string) => string, onSelect: (index: number) => void,
                               onSeek?: (seconds: number) => void): TimelineControl {
  svg.replaceChildren();
  labels.replaceChildren();
  if (!utterances.length) return { select() {}, setTime() {}, setMarkers() {}, setHighlight() {} };
  const speakers: string[] = [];
  for (const u of utterances) { const n = nameOf(u.speaker); if (!speakers.includes(n)) speakers.push(n); }
  const row = drawFrame(svg, labels, speakers, domain);
  const { x, pxPerSec } = scaleFor(domain);
  // A click on empty space (not a bar or a cross) seeks to that time.
  svg.onclick = ev => {
    if (!onSeek || (ev.target as Element).closest(".speech, .cut")) return;
    const px = ev.clientX - svg.getBoundingClientRect().left;
    onSeek(Math.min(Math.max(domain.start + (px - LEFT) / pxPerSec, domain.start), domain.end));
  };

  const bars: SVGRectElement[] = [];
  utterances.forEach((u, index) => {
    const name = nameOf(u.speaker);
    const bar = el("rect", { class: isFiller(u.speaker) ? "speech filler" : "speech", x: x(u.start), y: row(name) - 6, width: Math.max(x(u.end) - x(u.start), 2),
                             height: 12, rx: 2 }, svg);
    const content: TipContent = {
      heading: `${name} · ${clock(u.start)} → ${clock(u.end)} (${Math.round(u.end - u.start)} s)`,
      text: u.text || "(no text)",
    };
    bar.addEventListener("pointerenter", ev => tip.show(content, ev.clientX, ev.clientY));
    bar.addEventListener("pointermove", ev => tip.move(ev.clientX, ev.clientY));
    bar.addEventListener("pointerleave", () => tip.hide());
    bar.addEventListener("click", () => onSelect(index));
    bars.push(bar);
  });
  const markerLayer = el("g", {}, svg);

  // Drawn last so it sits on top of the bars.
  const playhead = el("line", { class: "playhead", y1: TOP, y2: Number(svg.getAttribute("height")) - 20, visibility: "hidden" }, svg);
  let lastPx: number | null = null; // where the playhead was drawn last time
  return {
    setMarkers(markers, onClick) {
      markerLayer.replaceChildren();
      markers.forEach((m, i) => {
        if (!speakers.includes(m.by) || !speakers.includes(m.interrupted)) return;
        const px = x(m.at), y = row(m.by) - 11, yOther = row(m.interrupted);
        el("line", { class: "cutlink", x1: px, y1: y, x2: px, y2: yOther }, markerLayer);
        const g = el("g", { class: "cut", transform: `translate(${px} ${y})` }, markerLayer);
        el("circle", { class: "cuthit", r: 9 }, g); // a bigger target than the cross itself
        el("path", { d: "M-4,-4 L4,4 M4,-4 L-4,4" }, g);
        const content: TipContent = { heading: m.heading, text: m.text };
        g.addEventListener("pointerenter", ev => tip.show(content, ev.clientX, ev.clientY));
        g.addEventListener("pointermove", ev => tip.move(ev.clientX, ev.clientY));
        g.addEventListener("pointerleave", () => tip.hide());
        g.addEventListener("click", () => onClick(i));
      });
    },
    setHighlight(indices) {
      const on = !!indices?.size;
      svg.classList.toggle("filtered", on);
      bars.forEach((b, i) => b.classList.toggle("hl", on && indices!.has(i)));
    },
    select(index, scroll = true) {
      bars.forEach((b, i) => b.classList.toggle("selected", i === index));
      if (scroll && index !== null) bars[index]?.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    },
    setTime(seconds) {
      playhead.setAttribute("visibility", seconds === null ? "hidden" : "visible");
      if (seconds === null) { lastPx = null; return; }
      const px = x(Math.min(Math.max(seconds, domain.start), domain.end));
      playhead.setAttribute("x1", String(px));
      playhead.setAttribute("x2", String(px));
      // Follow the playhead when it leaves the view by itself (playing past the edge, or a jump), but not when
      // the user has scrolled it out of view: then the last position is out of view too, and the view stays put.
      const scroller = svg.parentElement; // scrolls only this box, never the page
      if (scroller) {
        const inView = (p: number) => p >= scroller.scrollLeft + 40 && p <= scroller.scrollLeft + scroller.clientWidth - 40;
        const jumped = lastPx === null || Math.abs(px - lastPx) > 40;
        if (!inView(px) && (jumped || inView(lastPx!))) scroller.scrollLeft = Math.max(px - 80, 0);
      }
      lastPx = px;
    },
  };
}
