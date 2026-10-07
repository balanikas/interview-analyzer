// Works out the real names of a transcript's speakers from what is said (introductions, being addressed by name).

import Anthropic from "@anthropic-ai/sdk";

import { claudeCost } from "./cost.js";
import type { CostItem, Utterance } from "./shared/types.js";

const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5";
const HEAD = 30; // utterances from the start, where hosts introduce themselves and the guest
const TAIL = 8; // and from the end, where they sign off or thank the guest by name
const MAX_UTTERANCE_CHARS = 500;

const SYSTEM_PROMPT = `You are given excerpts of an interview or podcast transcript. Each line is a speaker label \
(a letter assigned by speaker diarization) followed by what that speaker said. Name each speaker.
- Use a person's full name only if the text reveals it: they introduce themselves, another speaker introduces or \
addresses them by name, or the host introduces the guest. Use the name as written, in its fullest form given.
- Never guess from voice, topic, or well-known people. If a speaker's name isn't stated, answer null.
- A label may be a non-person such as an ad read or a recording; answer null for those too.
Report your answer by calling the name_speakers tool.`;

const TOOL: Anthropic.Tool = {
  name: "name_speakers",
  description: "Report the real name of each speaker label, or null when the transcript doesn't reveal it.",
  input_schema: {
    type: "object",
    properties: {
      speakers: {
        type: "array",
        items: {
          type: "object",
          properties: { label: { type: "string" }, name: { type: ["string", "null"] } },
          required: ["label", "name"],
        },
      },
    },
    required: ["speakers"],
  },
};

/** Real names by label, only for speakers whose name the transcript reveals; null when the lookup couldn't be done (no key, API error). */
export async function inferNames(utterances: Utterance[], costs: CostItem[]): Promise<Record<string, string> | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const labels = new Set(utterances.map(u => u.speaker));
  const picked = utterances.filter((_, i) => i < HEAD || i >= utterances.length - TAIL);
  const excerpt = picked.map(u => `[${u.speaker}] ${u.text.slice(0, MAX_UTTERANCE_CHARS)}`).join("\n");
  try {
    const resp = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [TOOL],
      messages: [{ role: "user", content: `Speaker labels: ${[...labels].join(", ")}\n\n${excerpt}` }],
    });
    costs.push(claudeCost("speaker names", MODEL, resp.usage));
    const block = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const found = (block?.input as { speakers?: { label?: unknown; name?: unknown }[] } | undefined)?.speakers ?? [];
    const names: Record<string, string> = {};
    for (const { label, name } of found) {
      if (typeof label === "string" && labels.has(label) && typeof name === "string" && name.trim()) {
        names[label] = name.trim().slice(0, 80);
      }
    }
    return names;
  } catch (e) {
    console.error("Couldn't work out speaker names:", e instanceof Error ? e.message : e);
    return null;
  }
}
