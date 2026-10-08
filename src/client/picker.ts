// Downloaded audio: a searchable picker grouped by publisher; clicking an episode opens it.

import type { AudioFile } from "../shared/types.js";
import { $, h } from "./dom.js";
import { on, state } from "./store.js";

const picker = $<HTMLDialogElement>("picker");
const searchInput = $<HTMLInputElement>("search");

let open: (file: AudioFile) => void = () => {};

/** What clicking an episode does. */
export function onPick(fn: (file: AudioFile) => void): void { open = fn; }

function audioItem(file: AudioFile): HTMLLIElement {
  const { busy, data } = state();
  const meta = [file.duration === null ? null : `${Math.round(file.duration / 60)} min`, file.transcribed ? "✓" : null].filter(Boolean).join(" · ");
  const btn = h("button", file.name === data?.file ? "ep active" : "ep", file.source?.title ?? file.name, h("span", "meta", meta));
  btn.type = "button";
  btn.disabled = busy;
  btn.addEventListener("click", () => { picker.close(); open(file); });
  return h("li", "", btn);
}

// The files whose title contains every word of the search, grouped under their publisher, publishers A-Z;
// files with no known source go last under "Other".
function renderList(): void {
  const { files } = state();
  const words = searchInput.value.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, AudioFile[]>();
  for (const f of files) {
    const title = (f.source?.title ?? f.name).toLowerCase();
    if (!words.every(w => title.includes(w))) continue;
    const publisher = f.source?.publisher ?? "Other";
    groups.set(publisher, [...(groups.get(publisher) ?? []), f]);
  }
  if (!groups.size) {
    $("audiolist").replaceChildren(h("p", "none", files.length ? "No interviews match." : "No downloaded audio yet."));
    return;
  }
  const order = [...groups.keys()].sort((x, y) => (x === "Other" ? 1 : y === "Other" ? -1 : x.localeCompare(y)));
  $("audiolist").replaceChildren(...order.flatMap(publisher => [
    h("h3", "", `${publisher} (${groups.get(publisher)!.length})`),
    h("ul", "", ...groups.get(publisher)!.map(audioItem)),
  ]));
}
on(["files", "busy", "data"], renderList);

$("pick").addEventListener("click", () => {
  renderList();
  picker.showModal();
  searchInput.select();
});
searchInput.addEventListener("input", renderList);
// Enter opens the first match.
searchInput.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  $("audiolist").querySelector<HTMLButtonElement>("button.ep:not(:disabled)")?.click();
});
// A click on the backdrop lands on the dialog itself, outside its box.
picker.addEventListener("click", e => {
  const r = picker.getBoundingClientRect();
  if (e.target === picker && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) picker.close();
});
