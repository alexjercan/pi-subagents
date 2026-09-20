import type { HarnessEvent, HarnessMessage } from "./harness.ts";

export interface NormalizedRecord {
  events: HarnessEvent[];
  finalText?: string;
}

export interface HarnessAdapter {
  process: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
  };
  normalize(value: unknown): NormalizedRecord;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
}

export function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function message(value: unknown): HarnessMessage | undefined {
  const object = record(value);
  const role = string(object?.role);
  if (!object || !role || !("content" in object)) return undefined;
  return { role, content: object.content, value: object };
}

export function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map(record)
    .filter((block): block is Record<string, unknown> => block !== undefined)
    .filter((block) => block.type === "text")
    .map((block) => string(block.text) ?? "")
    .join("");
}
