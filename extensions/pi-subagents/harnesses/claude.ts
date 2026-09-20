import type {
  HarnessConfig,
  HarnessEvent,
  HarnessLaunchOptions,
  HarnessRequest,
} from "../harness.ts";
import {
  boolean,
  message,
  number,
  record,
  string,
  textContent,
  type HarnessAdapter,
  type NormalizedRecord,
} from "../protocol.ts";
import { SUBAGENT_TOOL_NAMES } from "../tool-names.ts";

type ClaudeConfig = Extract<HarnessConfig, { harness: "claude" }>;

function usage(
  value: Record<string, unknown>,
  cumulative: boolean,
  costUsd?: number,
) {
  const inputTokens = number(value.input_tokens) ?? 0;
  const outputTokens = number(value.output_tokens) ?? 0;
  const cacheReadTokens = number(value.cache_read_input_tokens) ?? 0;
  const cacheWriteTokens = number(value.cache_creation_input_tokens) ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    ...(cumulative
      ? {}
      : {
          contextTokens:
            inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        }),
    ...(costUsd === undefined ? {} : { costUsd }),
    cumulative,
  };
}

export function createClaudeAdapter(
  request: HarnessRequest,
  config: ClaudeConfig,
  options: HarnessLaunchOptions,
): HarnessAdapter {
  const toolNames = new Map<string, string>();
  const claudeTools = new Map([
    ["read", "Read"],
    ["grep", "Grep"],
    ["find", "Glob"],
    ["ls", "Glob"],
    ["bash", "Bash"],
    ["edit", "Edit"],
    ["write", "Write"],
    ["web_search", "WebSearch"],
    ["web_fetch", "WebFetch"],
  ]);
  const args = [
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
    "--input-format",
    "stream-json",
    "--verbose",
    "--append-system-prompt",
    options.system,
  ];
  if (options.tools !== undefined) {
    const mapped = [
      ...new Set(options.tools.map((tool) => claudeTools.get(tool))),
    ];
    args.push("--tools", mapped.join(","));
  }
  if (options.delegation) {
    args.push(
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          pi_subagents: {
            type: "http",
            url: options.delegation.url,
            headers: { Authorization: options.delegation.authorization },
          },
        },
      }),
      "--strict-mcp-config",
      "--allowedTools",
      SUBAGENT_TOOL_NAMES.map((name) => `mcp__pi_subagents__${name}`).join(","),
      "--disallowedTools",
      "Task,Agent,AskUserQuestion",
    );
  }
  return {
    process: {
      command: "claude",
      args,
      cwd: request.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
      },
    },
    initial: (prompt) => ({
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
    }),
    steer: (message) => ({
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    }),
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
    const resultUsage = record(event.usage);
    const costUsd = number(event.total_cost_usd);
    return {
      events: resultUsage
        ? [
            {
              type: "usage",
              usage: usage(resultUsage, true, costUsd),
            },
          ]
        : [],
      finalText: string(event.result),
      settled: true,
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

  const messageUsage = record(normalizedMessage.value.usage);
  if (messageUsage)
    events.push({ type: "usage", usage: usage(messageUsage, false) });
  const finalText =
    normalizedMessage.role === "assistant"
      ? textContent(normalizedMessage.content)
      : undefined;
  return { events, finalText };
}
