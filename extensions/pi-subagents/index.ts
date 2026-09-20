import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createAgentRuntime,
  type AgentRunSnapshot,
  type AgentRuntime,
} from "./runtime.ts";
import {
  activeAgentTree,
  agentSubtree,
  renderAgentTree,
  type AgentTreeTheme,
} from "./ui.ts";

interface SubagentDetails {
  rootId?: string;
  runs: AgentRunSnapshot[];
}

function colors(theme: Theme): AgentTreeTheme {
  return {
    accent: (text) => theme.fg("accent", text),
    dim: (text) => theme.fg("dim", text),
    error: (text) => theme.fg("error", text),
    muted: (text) => theme.fg("muted", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    bold: (text) => theme.bold(text),
  };
}

function nestedUsage(runs: AgentRunSnapshot[]): Usage {
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const run of runs) {
    usage.input += run.usage.inputTokens;
    usage.output += run.usage.outputTokens;
    usage.cacheRead += run.usage.cacheReadTokens;
    usage.cacheWrite += run.usage.cacheWriteTokens;
    usage.cost.total += run.usage.costUsd ?? 0;
  }
  usage.totalTokens =
    usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  return usage;
}

export default function piSubagents(pi: ExtensionAPI): void {
  let runtime: AgentRuntime | undefined;
  let widgetRuns: AgentRunSnapshot[] = [];
  let widgetTimer: NodeJS.Timeout | undefined;
  let clearWidget = () => undefined;
  const updates = new Set<
    (result: {
      content: Array<{ type: "text"; text: string }>;
      details: SubagentDetails;
    }) => void
  >();

  pi.on("session_start", async (_event, ctx) => {
    const refreshWidget = () => {
      if (ctx.mode !== "tui") return;
      if (widgetRuns.length === 0) {
        ctx.ui.setWidget("pi-subagents", undefined);
        if (widgetTimer) clearInterval(widgetTimer);
        widgetTimer = undefined;
        return;
      }
      ctx.ui.setWidget("pi-subagents", (_tui, theme) => ({
        render: (width) =>
          renderAgentTree(widgetRuns, width, colors(theme), Date.now()),
        invalidate() {},
      }));
    };
    const setWidget = (runs: AgentRunSnapshot[]) => {
      widgetRuns = activeAgentTree(runs);
      refreshWidget();
      if (ctx.mode === "tui" && widgetRuns.length > 0 && !widgetTimer)
        widgetTimer = setInterval(refreshWidget, 1000);
    };
    clearWidget = () => {
      if (widgetTimer) clearInterval(widgetTimer);
      widgetTimer = undefined;
      widgetRuns = [];
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-subagents", undefined);
    };
    runtime = await createAgentRuntime({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      onUpdate(runs) {
        setWidget(runs);
        const result = {
          content: [{ type: "text" as const, text: "Subagents updated" }],
          details: { runs },
        };
        for (const update of updates) update(result);
      },
    });
  });

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    updates.clear();
    clearWidget();
    clearWidget = () => undefined;
    await current?.close();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run a configured agent in an isolated process.",
    promptSnippet: "Delegate focused research, implementation, or review work",
    promptGuidelines: [
      "Use subagent to run the configured scout, worker, and review agents.",
    ],
    parameters: Type.Object({
      agent: Type.String({ description: "Configured agent name" }),
      task: Type.String({ description: "Task for the agent" }),
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      if (!runtime) {
        return {
          content: [{ type: "text", text: "Subagent runtime is not running" }],
          details: { runs: [] },
          isError: true,
        };
      }
      if (onUpdate) updates.add(onUpdate);
      const executionSignal = signal ?? new AbortController().signal;
      try {
        const result = await runtime.run(
          params.agent,
          params.task,
          undefined,
          executionSignal,
        );
        const runs = agentSubtree(runtime.list(), result.id);
        return {
          content: [
            {
              type: "text",
              text: result.result?.finalText || "(no output)",
            },
          ],
          details: { rootId: result.id, runs },
          usage: nestedUsage(runs),
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: error instanceof Error ? error.message : String(error),
            },
          ],
          details: { runs: runtime.list() },
          isError: true,
        };
      } finally {
        if (onUpdate) updates.delete(onUpdate);
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)}`,
        0,
        0,
      );
    },
    renderResult(result, { isPartial }, theme) {
      const details = result.details as SubagentDetails | undefined;
      if (isPartial)
        return new Text(theme.fg("muted", "Subagents running..."), 0, 0);
      if (!details || details.runs.length === 0) {
        const content = result.content[0];
        return new Text(
          content?.type === "text" ? content.text : "(no output)",
          0,
          0,
        );
      }
      return {
        render: (width: number) =>
          renderAgentTree(details.runs, width, colors(theme), Date.now()),
        invalidate() {},
      };
    },
  });
}
