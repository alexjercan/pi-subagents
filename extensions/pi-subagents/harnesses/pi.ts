import { fileURLToPath } from "node:url";
import type {
  HarnessConfig,
  HarnessEvent,
  HarnessLaunchOptions,
  HarnessRequest,
} from "../harness.ts";
import {
  message,
  number,
  record,
  string,
  textContent,
  type HarnessAdapter,
  type NormalizedRecord,
} from "../protocol.ts";
import { SUBAGENT_TOOL_NAMES } from "../tool-names.ts";

type PiConfig = Extract<HarnessConfig, { harness: "pi" }>;

export function createPiAdapter(
  request: HarnessRequest,
  config: PiConfig,
  options: HarnessLaunchOptions,
): HarnessAdapter {
  const args = [
    "--no-session",
    "--mode",
    "rpc",
    "--model",
    config.model,
    "--thinking",
    config.thinking,
    "--append-system-prompt",
    options.system,
  ];
  if (options.delegation) {
    args.push(
      "--extension",
      fileURLToPath(new URL("../bridge.ts", import.meta.url)),
    );
  }
  if (options.tools !== undefined) {
    const tools = options.delegation
      ? [...options.tools, ...SUBAGENT_TOOL_NAMES]
      : options.tools;
    if (tools.length === 0) args.push("--no-tools");
    else args.push("--tools", [...new Set(tools)].join(","));
  }
  return {
    process: {
      command: "pi",
      args,
      cwd: request.cwd,
      env: options.delegation
        ? {
            ...process.env,
            PI_SUBAGENTS_MCP_URL: options.delegation.url,
            PI_SUBAGENTS_MCP_AUTHORIZATION: options.delegation.authorization,
          }
        : undefined,
    },
    initial: (prompt) => ({ type: "prompt", message: prompt }),
    steer: (message) => ({ type: "steer", message }),
    normalize: normalizePiRecord,
  };
}

export function normalizePiRecord(value: unknown): NormalizedRecord {
  const event = record(value);
  const type = string(event?.type);
  if (!event || !type) return { events: [] };
  if (type === "agent_settled") return { events: [], settled: true };

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
  if (usage) {
    const cost = record(usage.cost);
    events.push({
      type: "usage",
      usage: {
        inputTokens: number(usage.input) ?? 0,
        outputTokens: number(usage.output) ?? 0,
        cacheReadTokens: number(usage.cacheRead) ?? 0,
        cacheWriteTokens: number(usage.cacheWrite) ?? 0,
        contextTokens: number(usage.totalTokens),
        costUsd: number(cost?.total),
        cumulative: false,
      },
    });
  }
  const finalText =
    normalizedMessage.role === "assistant"
      ? textContent(normalizedMessage.content)
      : undefined;
  return { events, finalText };
}
