// Works out the real names of a transcript's speakers from what is said (introductions, being addressed by name).

import { z } from "zod";

import { ask, claudeAvailable } from "../providers/claude.js";
import type { Analyzer } from "./analyzer.js";

const HEAD = 30; // utterances from the start, where hosts introduce themselves and the guest
const TAIL = 8; // and from the end, where they sign off or thank the guest by name
const MAX_UTTERANCE_CHARS = 500;

const SYSTEM_PROMPT = `You are given excerpts of an interview or podcast transcript. Each line is a speaker label \
(a letter assigned by speaker diarization) followed by what that speaker said. Name each speaker.
- Use a person's full name only if the text reveals it: they introduce themselves, another speaker introduces or \
addresses them by name, or the host introduces the guest. Use the name as written, in its fullest form given.
- Never guess from voice, topic, or well-known people. If a speaker's name isn't stated, answer null.
- A label may be a non-person such as an ad read or a recording; answer null for those too.
Give one entry for every speaker label.`;

const Reply = z.object({
  speakers: z.array(z.object({ label: z.string(), name: z.string().nullable() })),
});

/** Real names by label, only for speakers whose name the transcript reveals. */
export const speakers: Analyzer<"names"> = {
  key: "names",
  version: 1,
  message: "analyzing speakers...",
  async run(utterances) {
    if (!claudeAvailable()) return { value: null, costs: [] };
    const labels = new Set(utterances.map(u => u.speaker));
    const picked = utterances.filter((_, i) => i < HEAD || i >= utterances.length - TAIL);
    const excerpt = picked.map(u => `[${u.speaker}] ${u.text.slice(0, MAX_UTTERANCE_CHARS)}`).join("\n");
    try {
      const { value, cost } = await ask({
        label: "speaker names", system: SYSTEM_PROMPT, schema: Reply, maxTokens: 1024,
        content: `Speaker labels: ${[...labels].join(", ")}\n\n${excerpt}`,
      });
      if (!value) return { value: null, costs: [cost] };
      const names: Record<string, string> = {};
      for (const { label, name } of value.speakers) {
        if (labels.has(label) && name?.trim()) names[label] = name.trim().slice(0, 80);
      }
      return { value: names, costs: [cost] };
    } catch (e) {
      console.error("Couldn't work out speaker names:", e instanceof Error ? e.message : e);
      return { value: null, costs: [] };
    }
  },
};
