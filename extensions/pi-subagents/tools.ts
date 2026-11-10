import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const PROGRESS_INTERVAL_MS = 30000;

export type SubagentToolName =
  | "subagent_create"
  | "subagent_message"
  | "subagent_wait"
  | "subagent_list"
  | "subagent_stop"
  | "subagent_ask";

export interface ToolField {
  description: string;
  list?: true;
  optional?: true;
}

export interface ToolSpec {
  name: SubagentToolName;
  label: string;
  description: string;
  fields: Record<string, ToolField>;
  schema: z.ZodRawShape;
}

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
  isError?: boolean;
  terminate?: boolean;
}

interface McpToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export type ToolCall = (
  name: SubagentToolName,
  args: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<ToolResult>;

export interface Grant {
  callerRunId: string;
  agents: Set<string>;
}

export interface DelegationOperations {
  create(
    callerRunId: string,
    id: string,
    name: string,
    prompt: string,
  ): Promise<unknown>;
  message(callerRunId: string, id: string, message: string): Promise<unknown>;
  wait(
    callerRunId: string,
    ids: string[] | undefined,
    signal: AbortSignal,
  ): Promise<string[]>;
  stop(callerRunId: string, id: string): Promise<unknown>;
  list(callerRunId: string): Promise<unknown>;
  ask(
    callerRunId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
}

export const DELEGATION_GUIDANCE = [
  "You own subagents through the subagent_* tools.",
  "subagent_create returns immediately; a child's report or question arrives when you end your turn or when you call subagent_wait.",
  "Never sleep, poll, or busy-wait for a child.",
  "Answer or resume a child with subagent_message; ask your own owner with subagent_ask or by ending your turn with the question.",
].join(" ");

function zodShape(fields: Record<string, ToolField>): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, field] of Object.entries(fields)) {
    const base = field.list ? z.array(z.string().min(1)) : z.string().min(1);
    const described = base.describe(field.description);
    shape[name] = field.optional ? described.optional() : described;
  }
  return shape;
}

function spec(
  name: SubagentToolName,
  label: string,
  description: string,
  fields: Record<string, ToolField>,
): ToolSpec {
  return { name, label, description, fields, schema: zodShape(fields) };
}

export const SUBAGENT_TOOLS: readonly ToolSpec[] = [
  spec(
    "subagent_create",
    "Subagent Create",
    "Create a configured direct child and return immediately. Its report or question arrives when you end your turn or call subagent_wait. Never sleep or poll for a child.",
    {
      id: {
        description: "Child identifier, unique among your direct children",
      },
      name: { description: "Configured agent kind" },
      prompt: { description: "Initial prompt" },
    },
  ),
  spec(
    "subagent_message",
    "Subagent Message",
    "Send a message to a direct child: answer its question, steer it while it runs, or resume it when it is idle. Its next report arrives when you end your turn or call subagent_wait.",
    {
      id: { description: "Direct child identifier" },
      message: { description: "Answer, steering message, or resume prompt" },
    },
  ),
  spec(
    "subagent_wait",
    "Subagent Wait",
    "Block until a direct child has a report or question and return those notices. Pass ids to wait for specific children; omit ids to wait for any. Use this instead of sleeping or polling.",
    {
      ids: {
        description: "Direct child identifiers to wait for",
        list: true,
        optional: true,
      },
    },
  ),
  spec(
    "subagent_list",
    "Subagent List",
    "List the agent kinds you may create and your direct children that are running, waiting, or idle, with the report of each idle child.",
    {},
  ),
  spec(
    "subagent_stop",
    "Subagent Stop",
    "Stop a direct child and its subtree.",
    { id: { description: "Direct child identifier" } },
  ),
  spec(
    "subagent_ask",
    "Subagent Ask",
    "Ask your owner a question and wait for the answer. Use this, or end your turn with the question, when you need a decision or information from your owner. Never sleep or poll for the answer.",
    { prompt: { description: "Question for your owner" } },
  ),
];

export const OWNER_TOOLS: readonly ToolSpec[] = SUBAGENT_TOOLS.filter(
  (tool) => tool.name !== "subagent_ask",
);

export function toolSpec(name: SubagentToolName): ToolSpec {
  const found = SUBAGENT_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`Unknown subagent tool ${name}`);
  return found;
}

function text(value: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

export function failure(error: unknown): McpToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function withProgress<T>(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  work: () => Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return await work();
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress },
      })
      .catch(() => undefined);
  }, PROGRESS_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

function stringArgument(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function listArgument(
  args: Record<string, unknown>,
  name: string,
): string[] | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new Error(`${name} must be an array of strings`);
  return value as string[];
}

export function createToolServer(
  operations: DelegationOperations,
  grant: Grant,
): McpServer {
  const server = new McpServer({ name: "pi_subagents", version: "0.2.0" });
  const invoke = async (
    name: SubagentToolName,
    args: Record<string, unknown>,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<unknown> => {
    switch (name) {
      case "subagent_create": {
        const kind = stringArgument(args, "name");
        if (!grant.agents.has(kind))
          throw new Error(`Agent ${kind} is not an allowed delegate`);
        return await operations.create(
          grant.callerRunId,
          stringArgument(args, "id"),
          kind,
          stringArgument(args, "prompt"),
        );
      }
      case "subagent_message":
        return await operations.message(
          grant.callerRunId,
          stringArgument(args, "id"),
          stringArgument(args, "message"),
        );
      case "subagent_wait":
        return (
          await withProgress(extra, () =>
            operations.wait(
              grant.callerRunId,
              listArgument(args, "ids"),
              extra.signal,
            ),
          )
        ).join("\n\n");
      case "subagent_list":
        return await operations.list(grant.callerRunId);
      case "subagent_stop":
        return await withProgress(extra, () =>
          operations.stop(grant.callerRunId, stringArgument(args, "id")),
        );
      case "subagent_ask":
        return await withProgress(extra, () =>
          operations.ask(
            grant.callerRunId,
            stringArgument(args, "prompt"),
            extra.signal,
          ),
        );
    }
  };
  for (const tool of SUBAGENT_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args, extra) => {
        try {
          return text(await invoke(tool.name, args, extra));
        } catch (error) {
          return failure(error);
        }
      },
    );
  }
  return server;
}
