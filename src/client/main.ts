// The page: each panel module subscribes to the store when imported; this wires the inputs that start work.

import "./infotip.js";
import "./transcript.js";
import "./timeline-view.js";
import "./stats.js";
import "./interruptions.js";
import "./exchanges.js";
import { analyze, loadAudio, rejoin } from "./analyze.js";
import { $, setStatus } from "./dom.js";
import { onPick } from "./picker.js";

$("form").addEventListener("submit", e => {
  e.preventDefault();
  const audio_url = $<HTMLInputElement>("turl").value.trim();
  if (!audio_url) return setStatus("Paste a link to an audio file.", true);
  void analyze({ audio_url }, false);
});

onPick(file => void analyze({ file: file.name }, file.transcribed));

void loadAudio().then(rejoin);
