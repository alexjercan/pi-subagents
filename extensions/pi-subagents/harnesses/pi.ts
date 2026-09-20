import type {
  HarnessConfig,
  HarnessEvent,
  HarnessLaunchOptions,
  HarnessRequest,
} from "../harness.ts";
import {
  message,
  record,
  string,
  textContent,
  type HarnessAdapter,
  type NormalizedRecord,
} from "../protocol.ts";

type PiConfig = Extract<HarnessConfig, { harness: "pi" }>;

export function createPiAdapter(
  request: HarnessRequest,
  config: PiConfig,
  options: HarnessLaunchOptions,
): HarnessAdapter {
  const args = [
    "--print",
    "--no-session",
    "--mode",
    "json",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
    "--append-system-prompt",
    options.system,
  ];
  if (options.tools !== undefined) {
    if (options.tools.length === 0) args.push("--no-tools");
    else args.push("--tools", options.tools.join(","));
  }
  args.push("--", request.prompt);
  return {
    process: {
      command: "pi",
      args,
      cwd: request.cwd,
    },
    normalize: normalizePiRecord,
  };
}

export function normalizePiRecord(value: unknown): NormalizedRecord {
  const event = record(value);
  const type = string(event?.type);
  if (!event || !type) return { events: [] };

  if (type === "tool_execution_start") {
    return {
      events: [
        {
          type: "tool_start",
          id: string(event.toolCallId) ?? "",
          name: string(event.toolName) ?? "unknown",
          input: event.args,
        },
      ],
    };
  }

  if (type === "tool_execution_end") {
    return {
      events: [
        {
          type: "tool_end",
          id: string(event.toolCallId) ?? "",
          name: string(event.toolName) ?? "unknown",
          output: event.result,
          isError: event.isError === true,
        },
      ],
    };
  }

  if (type !== "message_end") return { events: [] };
  const normalizedMessage = message(event.message);
  if (!normalizedMessage) return { events: [] };
  const events: HarnessEvent[] = [
    { type: "message", message: normalizedMessage },
  ];
  const usage = record(normalizedMessage.value.usage);
  if (usage) events.push({ type: "usage", usage });
  const finalText =
    normalizedMessage.role === "assistant"
      ? textContent(normalizedMessage.content)
      : undefined;
  return { events, finalText };
}
