import type {
  HarnessConfig,
  HarnessEvent,
  HarnessRequest,
} from "../harness.ts";
import {
  boolean,
  message,
  record,
  string,
  textContent,
  type HarnessAdapter,
  type NormalizedRecord,
} from "../protocol.ts";

type ClaudeConfig = Extract<HarnessConfig, { harness: "claude" }>;

export function createClaudeAdapter(
  request: HarnessRequest,
  config: ClaudeConfig,
): HarnessAdapter {
  const toolNames = new Map<string, string>();
  return {
    process: {
      command: "claude",
      args: [
        "--print",
        "--no-session-persistence",
        "--model",
        config.model,
        "--effort",
        config.thinking,
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "stream-json",
        "--verbose",
        "--",
        request.prompt,
      ],
      cwd: request.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
      },
    },
    normalize(value) {
      return normalizeClaudeRecord(value, toolNames);
    },
  };
}

export function normalizeClaudeRecord(
  value: unknown,
  toolNames = new Map<string, string>(),
): NormalizedRecord {
  const event = record(value);
  const type = string(event?.type);
  if (!event || !type) return { events: [] };

  if (type === "result") {
    const usage = record(event.usage);
    return {
      events: usage ? [{ type: "usage", usage }] : [],
      finalText: string(event.result),
    };
  }

  if (type !== "assistant" && type !== "user") return { events: [] };
  const normalizedMessage = message(event.message);
  if (!normalizedMessage) return { events: [] };
  const events: HarnessEvent[] = [
    { type: "message", message: normalizedMessage },
  ];
  const blocks = Array.isArray(normalizedMessage.content)
    ? normalizedMessage.content
    : [];

  for (const value of blocks) {
    const block = record(value);
    if (!block) continue;
    if (block.type === "tool_use") {
      const id = string(block.id) ?? "";
      const name = string(block.name) ?? "unknown";
      toolNames.set(id, name);
      events.push({ type: "tool_start", id, name, input: block.input });
    }
    if (block.type === "tool_result") {
      const id = string(block.tool_use_id) ?? "";
      events.push({
        type: "tool_end",
        id,
        name: toolNames.get(id) ?? "unknown",
        output: block.content,
        isError: boolean(block.is_error) ?? false,
      });
    }
  }

  const usage = record(normalizedMessage.value.usage);
  if (usage) events.push({ type: "usage", usage });
  const finalText =
    normalizedMessage.role === "assistant"
      ? textContent(normalizedMessage.content)
      : undefined;
  return { events, finalText };
}
