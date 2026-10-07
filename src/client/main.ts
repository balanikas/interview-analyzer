import { renderTimeline, type TimelineControl } from "./timeline.js";
import type { AudioFile, ErrorResponse, Exchange, Interruption, RenameRequest, TranscribeEvent, TranscribeResponse, Utterance } from "../shared/types.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setStatus(msg: string, isError = false): void {
  $("status").textContent = msg;
  $("status").className = isError ? "error" : "";
}

const clock = (s: number): string => {
  const t = Math.floor(s), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, sec = t % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
};

// While a job runs, the Analyze button and every file's button are disabled.
let busy = false;
function setBusy(value: boolean): void {
  busy = value;
  $<HTMLButtonElement>("go").disabled = value;
  for (const b of $("audiolist").querySelectorAll("button")) b.disabled = value;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = (await r.json().catch(() => ({ error: `Server error (HTTP ${r.status}).` }))) as T | ErrorResponse;
  if (!r.ok || (data && typeof data === "object" && "error" in data)) throw new Error((data as ErrorResponse).error ?? "Request failed");
  return data as T;
}

// ---- Result: speaker stats, speaker timeline and transcript, linked ----

const ROLE_BY_SLOT = ["interviewer", "interviewee", "other"]; // reuses the three speaker colours

let current: TranscribeResponse | null = null;
let timeline: TimelineControl | null = null;
let selected: number | null = null;

const nameOf = (label: string): string => current?.names?.[label] ?? `Speaker ${label}`;

// Diarization labels in order of first appearance, each with a colour slot.
function speakerSlots(utterances: Utterance[]): Map<string, number> {
  const slots = new Map<string, number>();
  for (const u of utterances) if (!slots.has(u.speaker)) slots.set(u.speaker, Math.min(slots.size, ROLE_BY_SLOT.length - 1));
  return slots;
}

// Mark one utterance in both views. Scrolling the transcript is done inside its own panel, so the page itself doesn't jump.
function select(index: number | null, scrollTranscript: boolean): void {
  selected = index;
  for (const li of $("tlines").querySelectorAll("li.cur")) li.classList.remove("cur");
  const li = index === null ? undefined : $("tlines").children[index] as HTMLElement | undefined;
  li?.classList.add("cur");
  if (scrollTranscript && li) {
    const panel = $("transcript");
    const offset = li.getBoundingClientRect().top - panel.getBoundingClientRect().top;
    panel.scrollTo({ top: panel.scrollTop + offset - panel.clientHeight / 2 + li.offsetHeight / 2, behavior: "smooth" });
  }
}

// The timeline and the transcript lines: redrawn when a speaker is renamed.
function renderViews(data: TranscribeResponse): void {
  const slots = speakerSlots(data.utterances);
  $("tlines").replaceChildren(...data.utterances.map((u, i) => {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(u.start);
    const spk = document.createElement("span");
    spk.className = `spk ${ROLE_BY_SLOT[slots.get(u.speaker)!]}`;
    spk.textContent = nameOf(u.speaker);
    li.append(t, spk, u.text);
    li.addEventListener("click", () => { select(i, false); timeline?.select(i); seekTo(i); });
    return li;
  }));

  const end = Math.max(...data.utterances.map(u => u.end));
  timeline = renderTimeline($("speechline") as unknown as SVGSVGElement, $("speechlabels") as unknown as SVGSVGElement,
                            data.utterances, { start: 0, end }, nameOf, i => {
    select(i, true);
    timeline?.select(i);
    seekTo(i);
  }, seconds => { player.currentTime = seconds; syncToPlayer(); });
  select(selected, false);
  timeline.select(selected, false);
  timeline.setTime(player.currentTime);
  renderInterruptions(data);
  renderExchanges(data);
}

// Interruptions: crosses on the timeline and a clickable list. Both play from a few seconds before the cut-in.
const LEAD_IN = 3;

const KIND_LABEL: Record<Interruption["kind"], string> = { cut_off: "cut off", talk_over: "talk-over" };

function playInterruption(i: Interruption): void {
  select(i.index, true);
  timeline?.select(i.index, false);
  player.currentTime = Math.max(i.at - LEAD_IN, 0);
  void player.play().catch(() => { /* the browser may refuse until the page has been interacted with */ });
}

function renderInterruptions(data: TranscribeResponse): void {
  const list = data.interruptions;
  $("intbox").hidden = !list; // not judged (no API key, or the call failed): show nothing rather than "none"
  if (!list) { timeline?.setMarkers([], () => {}); return; }
  $("inttitle").textContent = `Interruptions (${list.length})`;
  const summary = (i: Interruption) => `${nameOf(i.by)} ${i.kind === "cut_off" ? "cut off" : "talked over"} ${nameOf(i.interrupted)}`;

  timeline?.setMarkers(list.map(i => ({
    at: i.at, by: nameOf(i.by), interrupted: nameOf(i.interrupted),
    heading: `${clock(i.at)} · ${summary(i)}`, text: i.reason || KIND_LABEL[i.kind],
  })), n => playInterruption(list[n]));

  if (!list.length) {
    const li = document.createElement("li");
    li.className = "none";
    li.textContent = "No interruptions found.";
    $("interruptions").replaceChildren(li);
    return;
  }
  $("interruptions").replaceChildren(...list.map(i => {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(i.at);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = KIND_LABEL[i.kind];
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = i.reason;
    li.append(t, summary(i), kind, why);
    li.addEventListener("click", () => playInterruption(i));
    return li;
  }));
}

// Questions and answers: a scorecard of counts, then every exchange with its verdicts. Playing starts at the question.
const QUESTION_LABEL: Record<Exchange["question"], string> = {
  open: "open", closed: "closed", follow_up: "follow-up", challenge: "challenge", softball: "softball",
};
const ANSWER_LABEL: Record<Exchange["answer"], string> = { direct: "direct", partial: "partial", pivot: "pivot", evasive: "evasive" };

function playExchange(e: Exchange): void {
  select(e.index, true);
  timeline?.select(e.index, false);
  player.currentTime = Math.max(e.at - LEAD_IN, 0);
  void player.play().catch(() => { /* the browser may refuse until the page has been interacted with */ });
}

// The scorecard figure last clicked: its questions or answers are highlighted on the timeline. Clicking it again clears it.
let metric: string | null = null;

const LEGEND: { title: string; terms: [string, string][] }[] = [
  { title: "How the host asked", terms: [
    ["open", "Asks for explanation, a story or an opinion, without leading the guest."],
    ["closed", "Can be answered with yes/no or a short fact."],
    ["follow-up", "Builds on something specific the guest just said."],
    ["challenge", "Puts an objection, contradiction or inconvenient fact to the guest."],
    ["softball", "Invites the guest to say what they already want to say, or flatters them."],
  ] },
  { title: "How the guest answered", terms: [
    ["direct", "Addresses the question that was asked."],
    ["partial", "Addresses only part of it, or gets there after a long detour."],
    ["pivot", "Answers a different question, or turns to the guest's own talking points."],
    ["evasive", "Says nothing checkable in reply to the question."],
  ] },
  { title: "Density of the answer", terms: [
    ["high density", "Plenty of concrete content: facts, figures, named examples, specific stories or reasoning."],
    ["medium density", "Some concrete content mixed with generalities."],
    ["low density", "Mostly generalities, repetition or filler, however long the answer is."],
  ] },
];

function renderLegend(): void {
  $("legend").replaceChildren(...LEGEND.map(group => {
    const div = document.createElement("div");
    const h = document.createElement("h3");
    h.textContent = group.title;
    div.append(h);
    for (const [term, tip] of group.terms) {
      const s = document.createElement("span");
      s.className = "term";
      s.append(term);
      const q = document.createElement("span");
      q.className = "info";
      q.tabIndex = 0;
      q.dataset.tip = tip;
      q.textContent = "ⓘ";
      s.append(q);
      div.append(s);
    }
    return div;
  }));
}
renderLegend();

function renderExchanges(data: TranscribeResponse): void {
  const items = data.exchanges?.items;
  $("exbox").hidden = $("exlistbox").hidden = !items?.length; // not judged, or no host questions: show nothing rather than zeros
  if (!items?.length) return;
  const count = (test: (e: Exchange) => boolean) => items.filter(test).length;
  const of = (n: number) => `${n} of ${items.length}`;
  const host = data.exchanges?.host;
  // The guest's reply to a question: the non-host utterances after it, up to the next question.
  const replyOf = (e: Exchange, k: number): number[] => {
    const stop = items[k + 1]?.index ?? data.utterances.length, out: number[] = [];
    for (let i = e.index + 1; i < stop; i++) if (data.utterances[i].speaker !== host) out.push(i);
    return out;
  };
  const figures: { label: string; test: (e: Exchange) => boolean; reply: boolean; tip: string }[] = [
    { label: "Follow-up questions", test: e => e.question === "follow_up", reply: false, tip: "Questions that build on what the guest just said." },
    { label: "Challenging questions", test: e => e.question === "challenge", reply: false, tip: "Questions that put an objection or inconvenient fact to the guest." },
    { label: "Direct answers", test: e => e.answer === "direct", reply: true, tip: "Answers that address the question asked." },
    { label: "Evasive answers", test: e => e.answer === "evasive", reply: true, tip: "Answers that say nothing checkable in reply to the question." },
    { label: "High-density answers", test: e => e.density === "high", reply: true, tip: "Answers with plenty of facts, figures, examples or reasoning." },
  ];
  const highlight = () => {
    const f = figures.find(x => x.label === metric);
    const set = new Set<number>();
    if (f) items.forEach((e, k) => { if (f.test(e)) (f.reply ? replyOf(e, k) : [e.index]).forEach(i => set.add(i)); });
    timeline?.setHighlight(set);
    $("score").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.metric === metric));
  };
  $("score").replaceChildren(...figures.map(f => {
    const d = document.createElement("button");
    d.type = "button";
    d.dataset.metric = f.label;
    d.title = `${f.tip} Click to highlight on the timeline.`;
    const b = document.createElement("b");
    b.textContent = pct(count(f.test) / items.length);
    d.append(b, `${f.label} (${of(count(f.test))})`);
    d.addEventListener("click", () => { metric = metric === f.label ? null : f.label; highlight(); });
    return d;
  }));
  highlight();

  const tag = (text: string, cls = "") => { const s = document.createElement("span"); s.className = `tag ${cls}`.trim(); s.textContent = text; return s; };
  $("exchanges").replaceChildren(...items.map(e => {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = clock(e.at);
    const why = document.createElement("span");
    why.className = "why";
    why.textContent = e.reason;
    li.append(t, tag(QUESTION_LABEL[e.question], e.question === "challenge" || e.question === "follow_up" ? "good" : ""),
              tag(ANSWER_LABEL[e.answer], e.answer === "pivot" || e.answer === "evasive" ? "bad" : ""),
              tag(`${e.density} density`), why);
    li.addEventListener("click", () => playExchange(e));
    return li;
  }));
}

// ---- Audio player, kept in step with the transcript and the timeline ----

const player = $<HTMLAudioElement>("player");
const playBtn = $<HTMLButtonElement>("playbtn");
const clockEl = $("clock");

const clockText = (sec: number) => {
  const s = Math.floor(Number.isFinite(sec) ? sec : 0), p = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}` : `${p(Math.floor(s / 60))}:${p(s % 60)}`;
};
const seekBar = $<HTMLInputElement>("seek");
let scrubbing = false;
const jump = (sec: number) => {
  const end = Number.isFinite(player.duration) ? player.duration : Infinity;
  player.currentTime = Math.min(Math.max(sec, 0), end);
  syncToPlayer();
};
$("backbtn").addEventListener("click", () => jump(player.currentTime - 10));
$("fwdbtn").addEventListener("click", () => jump(player.currentTime + 10));
seekBar.addEventListener("pointerdown", () => { scrubbing = true; });
seekBar.addEventListener("input", () => { jump(Number(seekBar.value)); updateControls(); });
for (const type of ["pointerup", "pointercancel", "change"]) seekBar.addEventListener(type, () => { scrubbing = false; });
const updateControls = () => {
  if (Number.isFinite(player.duration)) seekBar.max = String(player.duration);
  if (!scrubbing) seekBar.value = String(player.currentTime);
  clockEl.textContent = `${clockText(player.currentTime)} / ${clockText(player.duration)}`;
  playBtn.textContent = player.paused ? "▶" : "❚❚";
  playBtn.setAttribute("aria-label", player.paused ? "Play" : "Pause");
};
playBtn.addEventListener("click", () => {
  if (player.paused) void player.play().catch(() => { /* not allowed yet */ }); else player.pause();
});
for (const type of ["play", "pause", "ended", "seeked", "timeupdate", "loadedmetadata", "durationchange"]) player.addEventListener(type, updateControls);

// Clicking a transcript line or a timeline bar plays from the start of that utterance.
function seekTo(index: number): void {
  if (!current) return;
  player.currentTime = current.utterances[index].start;
  void player.play().catch(() => { /* the browser may refuse until the page has been interacted with */ });
}

// The utterance being spoken at `seconds`: the last one that has started (utterances are in time order).
function utteranceAt(utterances: Utterance[], seconds: number): number | null {
  let lo = 0, hi = utterances.length - 1, found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (utterances[mid].start <= seconds) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Move the playhead, and follow the audio in the transcript and on the timeline when it enters a new utterance.
function syncToPlayer(): void {
  if (!current) return;
  timeline?.setTime(player.currentTime);
  const i = utteranceAt(current.utterances, player.currentTime);
  if (i !== selected) {
    select(i, true);
    timeline?.select(i, false); // the playhead scrolls the timeline; scrolling the bar into view could move the page
  }
}

let frame = 0;
const tick = () => { syncToPlayer(); frame = requestAnimationFrame(tick); };
player.addEventListener("play", () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(tick); });
for (const type of ["pause", "ended", "seeked"]) player.addEventListener(type, () => {
  if (type !== "seeked") cancelAnimationFrame(frame);
  syncToPlayer();
});

const pct = (n: number) => `${Math.round(n * 100)}%`;

// One row per speaker: talk time and share, turns, average and longest turn, and interruptions.
function renderStats(data: TranscribeResponse): void {
  const slots = speakerSlots(data.utterances);
  const stats = [...slots.keys()].map(label => {
    const mine = data.utterances.filter(u => u.speaker === label);
    const seconds = mine.reduce((t, u) => t + (u.end - u.start), 0);
    return { label, seconds, turns: mine.length, longest: Math.max(...mine.map(u => u.end - u.start)) };
  });
  const total = stats.reduce((t, s) => t + s.seconds, 0) || 1;

  const cell = (text: string) => { const td = document.createElement("td"); td.textContent = text; return td; };
  const head = document.createElement("tr");
  for (const h of ["Speaker", "Talk time", "Share", "Turns", "Avg turn", "Longest turn", "Interrupted others", "Was interrupted"]) {
    const th = document.createElement("th");
    th.textContent = h;
    head.append(th);
  }

  const inputs: HTMLInputElement[] = [];
  const rows = stats.map(s => {
    const tr = document.createElement("tr");

    const who = document.createElement("td");
    const wrap = document.createElement("div");
    wrap.className = "who";
    const chip = document.createElement("span");
    chip.className = `spk ${ROLE_BY_SLOT[slots.get(s.label)!]}`;
    chip.textContent = s.label;
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = 80;
    input.placeholder = `Speaker ${s.label}`;
    input.value = data.names?.[s.label] ?? "";
    input.setAttribute("aria-label", `Name of speaker ${s.label}`);
    input.dataset.label = s.label;
    input.addEventListener("keydown", e => { if (e.key === "Enter") input.blur(); });
    input.addEventListener("change", () => void saveNames(inputs));
    inputs.push(input);
    wrap.append(chip, input);
    who.append(wrap);

    const share = document.createElement("td");
    const shareWrap = document.createElement("div");
    shareWrap.className = "share";
    const bar = document.createElement("div");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.style.width = pct(s.seconds / total);
    bar.append(fill);
    shareWrap.append(bar, pct(s.seconds / total));
    share.append(shareWrap);

    tr.append(who, cell(clock(s.seconds)), share, cell(String(s.turns)), cell(clock(s.seconds / s.turns)),
              cell(clock(s.longest)),
              cell(data.interruptions ? String(data.interruptions.filter(i => i.by === s.label).length) : "–"),
              cell(data.interruptions ? String(data.interruptions.filter(i => i.interrupted === s.label).length) : "–"));
    return tr;
  });
  $("stats").replaceChildren(head, ...rows);
}

// Saves every name in the table with the transcript, then redraws the views that show names.
async function saveNames(inputs: HTMLInputElement[]): Promise<void> {
  if (!current) return;
  const names = Object.fromEntries(inputs.map(i => [i.dataset.label!, i.value.trim()]));
  try {
    const saved = await postJson<TranscribeResponse>("/api/speakers", { file: current.file, names } satisfies RenameRequest);
    current = saved;
    renderViews(saved);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

function render(data: TranscribeResponse): void {
  current = data;
  selected = null;
  player.pause();
  player.src = `/api/audio/${encodeURIComponent(data.file)}`;
  $("result").hidden = !data.utterances.length;
  $("empty").hidden = data.utterances.length > 0;
  if (!data.utterances.length) return;
  renderNowPlaying(data);
  renderStats(data);
  renderViews(data);
  $("transcript").scrollTop = 0;
}

// ---- Analyze: a link to audio, or a file already downloaded ----

// Reads the server's progress lines into the log; resolves with the result.
async function streamTranscribe(body: unknown, onLog: (message: string) => void): Promise<TranscribeResponse> {
  const r = await fetch("/api/transcribe", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error(((await r.json().catch(() => null)) as ErrorResponse | null)?.error ?? `Server error (HTTP ${r.status}).`);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "", result: TranscribeResponse | null = null;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as TranscribeEvent;
    if ("log" in event) onLog(event.log);
    else if ("error" in event) throw new Error(event.error);
    else result = event.done;
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += value ?? "";
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    lines.forEach(handle);
    if (done) break;
  }
  handle(buffer);
  if (!result) throw new Error("The connection closed before the analysis finished.");
  return result;
}

function logLine(text: string, cls = ""): void {
  const div = document.createElement("div");
  div.textContent = text;
  div.className = cls;
  $("log").append(div);
  $("logbox").scrollTop = $("logbox").scrollHeight;
}

// Analyzing shows a terminal-style log in the centre; when it finishes a View button opens the result.
// A file whose analysis is already saved opens straight away.
async function analyze(body: { audio_url: string } | { file: string }, cached: boolean): Promise<void> {
  if (busy) return;
  setBusy(true);
  setStatus("");
  $("result").hidden = true;
  $("empty").hidden = true;
  $("log").replaceChildren();
  $("logbox").hidden = false;
  try {
    const data = await streamTranscribe(body, message => logLine(message));
    if (cached) {
      $("logbox").hidden = true;
      render(data);
      if (!data.utterances.length) setStatus("No speech was found in that audio.");
    } else {
      logLine(data.utterances.length ? "done." : "done. No speech was found in that audio.", "ok");
      if (data.utterances.length) {
        const view = document.createElement("button");
        view.type = "button";
        view.textContent = "View";
        view.addEventListener("click", () => { $("logbox").hidden = true; render(data); });
        $("log").append(view);
        view.focus();
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (cached) { $("logbox").hidden = true; setStatus(message, true); $("empty").hidden = false; }
    else logLine(`error: ${message}`, "err");
  } finally {
    await loadAudio(); // the file may be new, and its transcript is now saved
    setBusy(false);
  }
}

const linkInput = $<HTMLInputElement>("turl");

$("form").addEventListener("submit", e => {
  e.preventDefault();
  const audio_url = linkInput.value.trim();
  if (!audio_url) return setStatus("Paste a link to an audio file.", true);
  void analyze({ audio_url }, false);
});

// ---- Downloaded audio: a sidebar list grouped by publisher; clicking an episode opens it ----

let files: AudioFile[] = [];
const collapsed = new Set<string>(); // publishers the user folded, kept across redraws

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// The episode's title (linking to its page) above the player, and what its analysis cost.
function renderNowPlaying(data: TranscribeResponse): void {
  const file = files.find(f => f.name === data.file);
  const title = $("nowtitle");
  const src = file?.source;
  if (src && /^https?:\/\//.test(src.url)) {
    const a = document.createElement("a");
    a.href = src.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = src.title;
    title.replaceChildren(a);
  } else {
    title.textContent = src?.title ?? data.file;
  }
  const cost = data.cost;
  $("cost").textContent = cost ? `$${cost.total.toFixed(cost.total < 0.1 ? 3 : 2)}${cost.items.some(i => i.estimated) ? " est." : ""}` : "";
  $("cost").title = cost?.items.map(i => `${capitalize(i.label)}: $${i.usd.toFixed(4)}${i.estimated ? " (estimated)" : ""}`).join("\n") ?? "";
}

function audioItem(file: AudioFile): HTMLLIElement {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ep";
  btn.disabled = busy;
  if (file.name === current?.file) btn.classList.add("active");
  btn.append(file.source?.title ?? file.name);
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = [file.duration === null ? null : `${Math.round(file.duration / 60)} min`, file.transcribed ? "✓" : null].filter(Boolean).join(" · ");
  btn.append(meta);
  btn.addEventListener("click", () => void analyze({ file: file.name }, file.transcribed));
  li.append(btn);
  return li;
}

// Files grouped under their publisher, publishers A-Z; files with no known source go last under "Other".
function renderAudioList(list: AudioFile[]): void {
  files = list;
  const groups = new Map<string, AudioFile[]>();
  for (const f of list) {
    const publisher = f.source?.publisher ?? "Other";
    groups.set(publisher, [...(groups.get(publisher) ?? []), f]);
  }
  const order = [...groups.keys()].sort((x, y) => (x === "Other" ? 1 : y === "Other" ? -1 : x.localeCompare(y)));
  $("audiolist").replaceChildren(...order.map(publisher => {
    const details = document.createElement("details");
    details.open = !collapsed.has(publisher);
    details.addEventListener("toggle", () => { if (details.open) collapsed.delete(publisher); else collapsed.add(publisher); });
    const summary = document.createElement("summary");
    summary.textContent = `${publisher} (${groups.get(publisher)!.length})`;
    const ul = document.createElement("ul");
    ul.append(...groups.get(publisher)!.map(audioItem));
    details.append(summary, ul);
    return details;
  }));
  if (current && !$("result").hidden) renderNowPlaying(current);
}

async function loadAudio(): Promise<void> {
  try {
    renderAudioList(await (await fetch("/api/audio")).json() as AudioFile[]);
  } catch {
    setStatus("Couldn't list the downloaded audio.", true);
  }
}

void loadAudio();
