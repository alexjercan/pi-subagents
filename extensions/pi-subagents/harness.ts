import { createClaudeAdapter } from "./harnesses/claude.ts";
import { createPiAdapter } from "./harnesses/pi.ts";
import type { AgentTool } from "./config.ts";
import { spawnJsonlProcess } from "./process.ts";

export type PiThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type ClaudeThinkingLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ClaudePermissionMode = "auto" | "bypassPermissions";

export type HarnessConfig =
  | { harness: "pi"; model: string; thinking: PiThinkingLevel }
  | {
      harness: "claude";
      model: string;
      thinking: ClaudeThinkingLevel;
      permissionMode: ClaudePermissionMode;
    };

export interface HarnessRequest {
  cwd: string;
  prompt: string;
}

export interface HarnessLaunchOptions {
  system: string;
  tools?: AgentTool[];
  delegation?: {
    url: string;
    authorization: string;
  };
}

export interface HarnessMessage {
  role: string;
  content: unknown;
  value: Record<string, unknown>;
}

export interface HarnessUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens?: number;
  costUsd?: number;
  cumulative: boolean;
}

export type HarnessEvent =
  | { type: "message"; message: HarnessMessage }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | {
      type: "tool_end";
      id: string;
      name: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "usage"; usage: HarnessUsage };

export interface HarnessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  finalText: string;
  stderr: string;
}

export interface HarnessRun {
  pid: number;
  completion: Promise<HarnessResult>;
  send(message: string): Promise<void>;
  stop(): void;
}

export function spawnHarness(
  request: HarnessRequest,
  config: HarnessConfig,
  options: HarnessLaunchOptions,
  onEvent: (event: HarnessEvent) => void,
): HarnessRun {
  const adapter =
    config.harness === "pi"
      ? createPiAdapter(request, config, options)
      : createClaudeAdapter(request, config, options);
  let finalText = "";
  let settled = false;
  let processRun!: ReturnType<typeof spawnJsonlProcess>;
  processRun = spawnJsonlProcess(adapter.process, (value) => {
    const normalized = adapter.normalize(value);
    if (normalized.finalText !== undefined) finalText = normalized.finalText;
    for (const event of normalized.events) onEvent(event);
    if (normalized.settled) {
      settled = true;
      processRun.end();
    }
  });
  let initialError: unknown;
  const initialized = processRun
    .send(adapter.initial(request.prompt))
    .catch((error) => {
      initialError = error;
      processRun.stop();
    });
  return {
    pid: processRun.pid,
    send: (message) => processRun.send(adapter.steer(message)),
    stop: processRun.stop,
    completion: Promise.all([initialized, processRun.completion]).then(
      ([, result]) => {
        if (initialError) throw initialError;
        if (!settled && result.signal === null)
          throw new Error("Harness exited before reporting completion");
        return { ...result, finalText };
      },
    ),
  };
}
