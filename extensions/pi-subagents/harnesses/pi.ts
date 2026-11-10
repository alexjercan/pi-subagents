import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
import { SUBAGENT_TOOLS } from "../tools.ts";

type PiConfig = Extract<HarnessConfig, { harness: "pi" }>;

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export async function piSessionPath(
  sessionsDir: string,
  runId: string,
): Promise<string | undefined> {
  const entries = await readdir(sessionsDir);
  const name = entries.find((entry) => entry.endsWith(`_${runId}.jsonl`));
  return name === undefined ? undefined : join(sessionsDir, name);
}

export function createPiAdapter(
  request: HarnessRequest,
  config: PiConfig,
  options: HarnessLaunchOptions,
): HarnessAdapter {
  const args = [
    "--mode",
    "rpc",
    "--session-id",
    request.runId,
    "--session-dir",
    request.sessionsDir,
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
    const tools: string[] = options.delegation
      ? [...options.tools, ...SUBAGENT_TOOLS.map((tool) => tool.name)]
      : options.tools;
    if (tools.length === 0) args.push("--no-tools");
    else args.push("--tools", [...new Set(tools)].join(","));
  }
  const http = options.delegation?.http();
  return {
    process: {
      command: "pi",
      args,
      cwd: request.cwd,
      env: {
        ...process.env,
        PI_SUBAGENTS_RUN_ID: request.runId,
        ...(http
          ? {
              PI_SUBAGENTS_MCP_URL: http.url,
              PI_SUBAGENTS_MCP_AUTHORIZATION: http.authorization,
            }
          : {}),
      },
    },
    opening: [],
    prompt: (message) => ({
      type: "prompt",
      message,
      streamingBehavior: "steer",
    }),
    normalize: normalizePiRecord,
  };
}

export function normalizePiRecord(value: unknown): NormalizedRecord {
  const event = record(value);
  const type = string(event?.type);
  if (!event || !type) return { events: [] };
  if (type === "agent_settled") return { events: [], settled: true };
  if (type === "response") {
    if (event.success !== false) return { events: [] };
    return {
      events: [],
      error:
        string(event.error) ??
        `Pi rejected ${string(event.command) ?? "a command"}`,
      settled: true,
    };
  }
  if (type === "extension_ui_request") {
    const id = string(event.id);
    if (id === undefined || !DIALOG_METHODS.has(string(event.method) ?? ""))
      return { events: [] };
    return {
      events: [],
      reply: { type: "extension_ui_response", id, cancelled: true },
    };
  }

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
  if (normalizedMessage.role !== "assistant") return { events };
  return {
    events,
    finalText: textContent(normalizedMessage.content),
    error:
      normalizedMessage.value.stopReason === "error"
        ? (string(normalizedMessage.value.errorMessage) ?? "Pi turn failed")
        : undefined,
  };
}
