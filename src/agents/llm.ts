import { generateText } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

export const PLANNER_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export class LlmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmOutputError";
  }
}

/**
 * Pull the first JSON object out of model output. Llama sometimes wraps JSON
 * in prose or ``` fences despite being told not to.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmOutputError("Model output contained no JSON object");
  }
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch (err) {
    throw new LlmOutputError(
      `Model output was not valid JSON: ${err instanceof Error ? err.message : err}`
    );
  }
}

export function parseJson<T extends z.ZodType>(
  schema: T,
  text: string
): z.output<T> {
  const result = schema.safeParse(extractJson(text));
  if (!result.success) {
    throw new LlmOutputError(
      `Model JSON didn't match the schema: ${z.prettifyError(result.error)}`
    );
  }
  return result.data;
}

/**
 * One non-streaming call that must return JSON matching `schema`. Throws
 * LlmOutputError otherwise, so a Workflow step can retry it.
 */
export async function generateJson<T extends z.ZodType>(
  ai: Ai,
  schema: T,
  system: string,
  prompt: string,
  maxOutputTokens = 2000
): Promise<z.output<T>> {
  const workersai = createWorkersAI({ binding: ai });
  const { text } = await generateText({
    model: workersai(PLANNER_MODEL),
    system: `${system}\n\nRespond with a single JSON object only. No prose, no markdown fences.`,
    prompt,
    maxOutputTokens,
    temperature: 0.4
  });
  return parseJson(schema, text);
}
