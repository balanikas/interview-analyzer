// One way to ask Claude for structured data: a system prompt, the content, and a zod schema the answer must follow.
// Structured outputs constrain the reply to the schema, and the SDK parses it, so callers get typed values back.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";

import { config } from "../config.js";
import { claudeCost } from "../cost.js";
import type { CostItem } from "../shared/types.js";

let client: Anthropic | null = null;

/** False when no API key is set: the analyses that need Claude are left undone, to be retried later. */
export const claudeAvailable = (): boolean => !!config.anthropicKey;

export interface Answer<T> {
  /** Null when the reply didn't parse (cut off, or refused). */
  value: T | null;
  cost: CostItem;
}

export async function ask<S extends z.ZodType>(request: {
  /** Names the call in the cost breakdown. */
  label: string;
  system: string;
  content: string;
  schema: S;
  maxTokens: number;
}): Promise<Answer<z.infer<S>>> {
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  const resp = await client.messages.parse({
    model: config.claudeModel,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.content }],
    output_config: { format: zodOutputFormat(request.schema) },
  });
  return { value: resp.parsed_output ?? null, cost: claudeCost(request.label, config.claudeModel, resp.usage) };
}
