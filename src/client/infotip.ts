// The (i) tooltips: one shared element, filled from the hovered (i).
// It starts at the (i) and runs right, moving left only as far as it must to stay in the window; it opens below the (i),
// or above it when there is more room there. The pointer can move onto it (to scroll the legend), so hiding waits a moment.

import { $ } from "./dom.js";

const infoTip = $("infotip");
let infoFor: HTMLElement | null = null, infoHide = 0;

function showInfo(info: HTMLElement): void {
  clearTimeout(infoHide);
  if (infoFor === info) return;
  infoFor = info;
  const legend = info.querySelector(".legend");
  infoTip.classList.toggle("wide", !!legend);
  if (legend) infoTip.replaceChildren(...[...legend.childNodes].map(n => n.cloneNode(true)));
  else infoTip.textContent = info.dataset.tip ?? "";
  infoTip.style.cssText = "left:0; top:0; max-height:none";
  infoTip.hidden = false;
  const r = info.getBoundingClientRect(), gap = 4, edge = 16;
  const below = innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
  const h = infoTip.offsetHeight, w = infoTip.offsetWidth;
  const left = Math.max(edge, Math.min(r.left, innerWidth - edge - w));
  const top = h <= below || below >= above ? r.bottom + gap : Math.max(edge, r.top - gap - h);
  infoTip.style.cssText = `left:${left}px; top:${top}px; max-height:${Math.max(below, above)}px`;
}

function hideInfo(): void {
  clearTimeout(infoHide);
  infoHide = window.setTimeout(() => { infoTip.hidden = true; infoFor = null; }, 150);
}

const infoOf = (t: EventTarget | null) => (t instanceof Element ? t.closest<HTMLElement>(".info") : null);
document.addEventListener("mouseover", e => { const info = infoOf(e.target); if (info) showInfo(info); });
document.addEventListener("mouseout", e => { if (infoOf(e.target)) hideInfo(); });
document.addEventListener("focusin", e => { const info = infoOf(e.target); if (info) showInfo(info); });
document.addEventListener("focusout", e => { if (infoOf(e.target)) hideInfo(); });
infoTip.addEventListener("mouseenter", () => clearTimeout(infoHide));
infoTip.addEventListener("mouseleave", hideInfo);
// It's placed for where the (i) was, so a scroll anywhere but inside it puts it away.
document.addEventListener("scroll", e => { if (e.target !== infoTip) { infoTip.hidden = true; infoFor = null; } }, true);
