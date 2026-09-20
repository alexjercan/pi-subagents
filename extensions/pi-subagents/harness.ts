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

export type HarnessConfig =
  | { harness: "pi"; model: string; thinking: PiThinkingLevel }
  | { harness: "claude"; model: string; thinking: ClaudeThinkingLevel };

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
  const processRun = spawnJsonlProcess(adapter.process, (value) => {
    const normalized = adapter.normalize(value);
    if (normalized.finalText !== undefined) finalText = normalized.finalText;
    for (const event of normalized.events) onEvent(event);
  });
  return {
    pid: processRun.pid,
    stop: processRun.stop,
    completion: processRun.completion.then((result) => ({
      ...result,
      finalText,
    })),
  };
}
