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
  sessionId?: string;
}

export interface HarnessLaunchOptions {
  system: string;
  tools?: AgentTool[];
  onTurnSettled?: () => boolean;
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
  finished: boolean;
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
  const reports: string[] = [];
  let turnText = "";
  let turnError: string | undefined;
  let failure: Error | undefined;
  let finished = false;
  let turnActive = true;
  let stopRequested = false;
  let processRun!: ReturnType<typeof spawnJsonlProcess>;
  const fail = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    processRun.stop();
  };
  processRun = spawnJsonlProcess(adapter.process, (value) => {
    const normalized = adapter.normalize(value);
    if (normalized.finalText !== undefined) {
      turnText = normalized.finalText;
      turnError = normalized.error;
    } else if (normalized.error !== undefined) {
      turnError = normalized.error;
    }
    for (const event of normalized.events) onEvent(event);
    if (normalized.reply !== undefined)
      processRun.send(normalized.reply).catch(fail);
    if (!normalized.settled) return;
    if (turnError !== undefined) {
      fail(new Error(turnError));
      return;
    }
    if (turnText) reports.push(turnText);
    turnText = "";
    turnActive = false;
    if (options.onTurnSettled?.() ?? true) {
      finished = true;
      processRun.end();
    }
  });
  const initialized = processRun
    .send(adapter.prompt(request.prompt))
    .catch(fail);
  return {
    pid: processRun.pid,
    send: (message) => {
      turnActive = true;
      return processRun.send(adapter.prompt(message));
    },
    stop: () => {
      stopRequested = true;
      processRun.stop();
    },
    completion: Promise.all([initialized, processRun.completion]).then(
      ([, result]) => {
        const withReports = (message: string) =>
          new Error([message, ...reports].join("\n\n"));
        if (failure) throw withReports(failure.message);
        if (turnActive && result.signal === null && !stopRequested) {
          const stderr = result.stderr.trim();
          throw withReports(
            `Harness exited with code ${result.exitCode} before reporting completion${stderr ? `\n${stderr}` : ""}`,
          );
        }
        return { ...result, finished, finalText: reports.join("\n\n") };
      },
    ),
  };
}
