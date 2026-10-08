// Small DOM helpers shared by the panels.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** An element with a class and children. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  el.append(...children);
  return el;
}

/** Scrolls `panel` so `item` is in its middle; only the panel moves, never the page. */
export function centerIn(panel: HTMLElement, item: HTMLElement): void {
  const offset = item.getBoundingClientRect().top - panel.getBoundingClientRect().top;
  panel.scrollTo({ top: panel.scrollTop + offset - panel.clientHeight / 2 + item.offsetHeight / 2, behavior: "smooth" });
}

export function setStatus(msg: string, isError = false): void {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}
