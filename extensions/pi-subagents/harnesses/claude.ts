import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type {
  JSONRPCMessage,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
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
import { SUBAGENT_TOOLS } from "../tools.ts";

type ClaudeConfig = Extract<HarnessConfig, { harness: "claude" }>;

const SERVER_NAME = "pi_subagents";

export interface ClaudeState {
  toolNames: Map<string, string>;
  control?: ControlChannel;
}

export interface ControlChannel {
  forward(
    controlRequestId: string,
    message: JSONRPCMessage,
  ): Promise<JSONRPCMessage | undefined>;
  cancel(controlRequestId: string): void;
}

export function createClaudeState(): ClaudeState {
  return { toolNames: new Map() };
}

export function claudeSessionPath(cwd: string, runId: string): string {
  return join(
    homedir(),
    ".claude",
    "projects",
    cwd.replace(/[^A-Za-z0-9]/g, "-"),
    `${runId}.jsonl`,
  );
}

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

function createControlChannel(server: McpServer): ControlChannel {
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const pending = new Map<RequestId, (response: JSONRPCMessage) => void>();
  const requestIds = new Map<string, RequestId>();
  clientEnd.onmessage = (response) => {
    const id = "id" in response ? response.id : undefined;
    if (id === undefined || "method" in response) return;
    const resolve = pending.get(id);
    pending.delete(id);
    resolve?.(response);
  };
  const ready = server.connect(serverEnd).then(() => clientEnd.start());
  return {
    async forward(controlRequestId, value) {
      await ready;
      const id = "id" in value ? value.id : undefined;
      if (id === undefined || !("method" in value)) {
        await clientEnd.send(value);
        return undefined;
      }
      requestIds.set(controlRequestId, id);
      const response = new Promise<JSONRPCMessage>((resolve) => {
        pending.set(id, resolve);
      });
      await clientEnd.send(value);
      try {
        return await response;
      } finally {
        requestIds.delete(controlRequestId);
      }
    },
    cancel(controlRequestId) {
      const requestId = requestIds.get(controlRequestId);
      requestIds.delete(controlRequestId);
      if (requestId === undefined || !pending.has(requestId)) return;
      pending.delete(requestId);
      void clientEnd.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId },
      });
    },
  };
}

export function createClaudeAdapter(
  request: HarnessRequest,
  config: ClaudeConfig,
  options: HarnessLaunchOptions,
): HarnessAdapter {
  const state = createClaudeState();
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
    request.resume ? "--resume" : "--session-id",
    request.runId,
    "--model",
    config.model,
    "--effort",
    config.thinking,
    "--permission-mode",
    config.permissionMode,
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
  const opening: unknown[] = [];
  if (options.delegation) {
    state.control = createControlChannel(options.delegation.server());
    args.push(
      "--strict-mcp-config",
      "--allowedTools",
      SUBAGENT_TOOLS.map((tool) => tool.name).join(","),
      "--disallowedTools",
      "Task,Agent,AskUserQuestion",
    );
    opening.push({
      type: "control_request",
      request_id: "initialize",
      request: {
        subtype: "initialize",
        sdkMcpServers: [SERVER_NAME],
        sdkMcpServerConfigs: {
          [SERVER_NAME]: { timeout: 2147483647, alwaysLoad: true },
        },
      },
    });
  }
  return {
    process: {
      command: "claude",
      args,
      cwd: request.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
        ...(options.delegation ? { CLAUDE_AGENT_SDK_MCP_NO_PREFIX: "1" } : {}),
      },
    },
    opening,
    prompt: (message) => ({
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
    }),
    normalize(value) {
      return normalizeClaudeRecord(value, state);
    },
  };
}

function resultError(
  event: Record<string, unknown>,
  finalText: string | undefined,
): string | undefined {
  const subtype = string(event.subtype);
  if (
    event.is_error !== true &&
    (subtype === undefined || subtype === "success")
  )
    return undefined;
  const errors = Array.isArray(event.errors)
    ? event.errors.filter((value): value is string => typeof value === "string")
    : [];
  return (
    errors.join("\n") ||
    finalText ||
    `Claude turn failed: ${subtype ?? "error"}`
  );
}

function controlResponse(requestId: string, response: unknown) {
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: { mcp_response: response },
    },
  };
}

function normalizeControlRequest(
  event: Record<string, unknown>,
  state: ClaudeState,
): NormalizedRecord {
  const controlRequest = record(event.request);
  const requestId = string(event.request_id);
  const subtype = string(controlRequest?.subtype);
  if (!controlRequest || requestId === undefined || subtype === undefined)
    return {
      events: [],
      error: "Claude sent a malformed control request",
      settled: true,
    };
  if (subtype !== "mcp_message" || !state.control)
    return {
      events: [],
      error: `Claude sent an unsupported control request: ${subtype}`,
      settled: true,
    };
  const mcpMessage = record(controlRequest.message);
  if (!mcpMessage)
    return {
      events: [],
      error: "Claude sent an MCP control request without a message",
      settled: true,
    };
  if (mcpMessage.id === undefined)
    return {
      events: [],
      reply: state.control
        .forward(requestId, mcpMessage as unknown as JSONRPCMessage)
        .then(() =>
          controlResponse(requestId, { jsonrpc: "2.0", id: null, result: {} }),
        ),
    };
  return {
    events: [],
    reply: state.control
      .forward(requestId, mcpMessage as unknown as JSONRPCMessage)
      .then((response) =>
        response === undefined
          ? undefined
          : controlResponse(requestId, response),
      ),
  };
}

export function normalizeClaudeRecord(
  value: unknown,
  state: ClaudeState = createClaudeState(),
): NormalizedRecord {
  const event = record(value);
  const type = string(event?.type);
  if (!event || !type) return { events: [] };

  if (type === "control_request") return normalizeControlRequest(event, state);
  if (type === "control_cancel_request") {
    const requestId = string(event.request_id);
    if (requestId !== undefined) state.control?.cancel(requestId);
    return { events: [] };
  }

  if (type === "result") {
    const resultUsage = record(event.usage);
    const costUsd = number(event.total_cost_usd);
    const finalText = string(event.result);
    return {
      events: resultUsage
        ? [
            {
              type: "usage",
              usage: usage(resultUsage, true, costUsd),
            },
          ]
        : [],
      finalText,
      error: resultError(event, finalText),
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
      state.toolNames.set(id, name);
      events.push({ type: "tool_start", id, name, input: block.input });
    }
    if (block.type === "tool_result") {
      const id = string(block.tool_use_id) ?? "";
      events.push({
        type: "tool_end",
        id,
        name: state.toolNames.get(id) ?? "unknown",
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
