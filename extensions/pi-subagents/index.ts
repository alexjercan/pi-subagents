import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createAgentRuntime,
  type AgentInventory,
  type AgentRunSnapshot,
  type AgentRuntime,
} from "./runtime.ts";
import { activeAgentTree, renderAgentTree, type AgentTreeTheme } from "./ui.ts";

interface SubagentDetails {
  runs: AgentRunSnapshot[];
  inventory?: AgentInventory;
  error?: boolean;
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

function errorResult(
  error: unknown,
  runs: AgentRunSnapshot[] = [],
): {
  content: Array<{ type: "text"; text: string }>;
  details: SubagentDetails;
  isError: true;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    details: { runs, error: true },
    isError: true,
  };
}

export default function piSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENTS_MCP_URL) return;

  let runtime: AgentRuntime | undefined;
  let widgetRuns: AgentRunSnapshot[] = [];
  let widgetTimer: NodeJS.Timeout | undefined;
  let clearWidget = () => undefined;

  const wakeOwner = (content: string) => {
    pi.sendMessage(
      { customType: "pi-subagents", content, display: true },
      { triggerTurn: true, deliverAs: "steer" },
    );
  };

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
          renderAgentTree(
            widgetRuns,
            width,
            colors(theme),
            Date.now(),
            "active",
          ),
        invalidate() {},
      }));
    };
    const setWidget = (runs: AgentRunSnapshot[]) => {
      widgetRuns = activeAgentTree(runs).length > 0 ? runs : [];
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
      onUpdate: setWidget,
      onRootQuestion(id, prompt) {
        wakeOwner(
          `Subagent ${id} is waiting for an answer.\nQuestion: ${prompt}\nAnswer it with subagent_message using id ${id}.`,
        );
      },
      onRootMessage(message) {
        wakeOwner(message);
      },
    });
  });

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    clearWidget();
    clearWidget = () => undefined;
    await current?.close();
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Start a configured direct child, end this turn, and wake when the active root cohort completes.",
    promptSnippet: "Start configured subagents and wait for their completion",
    promptGuidelines: [
      "Call subagent_list only to discover configured agent kinds before delegation.",
      "Use a distinct id for each directly owned subagent.",
      "Do not poll or sleep after starting subagents; the turn ends and completed subagents wake you with their final output.",
    ],
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Child identifier" }),
      name: Type.String({ minLength: 1, description: "Configured agent kind" }),
      prompt: Type.String({ minLength: 1, description: "Initial prompt" }),
    }),
    async execute(_toolCallId, params) {
      if (!runtime) return errorResult("Subagent runtime is not running");
      try {
        const run = await runtime.start(params);
        return {
          content: [
            {
              type: "text",
              text: `Started subagent ${run.id} using ${run.agent}`,
            },
          ],
          details: { runs: [run] },
          terminate: true,
        };
      } catch (error) {
        return errorResult(error, runtime.list());
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.id)} ${theme.fg("muted", args.name)}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      const fallback = content?.type === "text" ? content.text : "(no output)";
      const details = result.details as SubagentDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", fallback), 0, 0);
      const run = details?.runs[0];
      if (!run) return new Text(fallback, 0, 0);
      return new Text(
        `${theme.fg("success", "started")} ${theme.fg("accent", run.id)} ${theme.fg("muted", `(${run.agent})`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Subagent Message",
    description:
      "Send a message to a directly owned subagent and end this turn while it runs.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "Direct child identifier" }),
      message: Type.String({
        minLength: 1,
        description: "Steering message or answer",
      }),
    }),
    async execute(_toolCallId, params) {
      if (!runtime) return errorResult("Subagent runtime is not running");
      try {
        await runtime.message(undefined, params.id, params.message);
        return {
          content: [{ type: "text", text: `Message sent to ${params.id}` }],
          details: { runs: runtime.list() },
          terminate: true,
        };
      } catch (error) {
        return errorResult(error, runtime.list());
      }
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "(no output)";
      const details = result.details as SubagentDetails | undefined;
      return new Text(theme.fg(details?.error ? "error" : "muted", text), 0, 0);
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "Subagent List",
    description: "List configured agent kinds and directly owned runs.",
    parameters: Type.Object({}),
    async execute() {
      if (!runtime) return errorResult("Subagent runtime is not running");
      try {
        const inventory = await runtime.inventory();
        return {
          content: [{ type: "text", text: JSON.stringify(inventory) }],
          details: { runs: runtime.list(), inventory },
        };
      } catch (error) {
        return errorResult(error, runtime.list());
      }
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      const fallback = content?.type === "text" ? content.text : "(no output)";
      const details = result.details as SubagentDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", fallback), 0, 0);
      if (!details?.inventory) return new Text(fallback, 0, 0);
      const kinds = details.inventory.kinds.map((kind) => kind.name);
      const runs = details.inventory.runs.map(
        (run) => `${run.id} (${run.name}) [${run.status}]`,
      );
      const kindLine = `${kinds.length} ${kinds.length === 1 ? "kind" : "kinds"}: ${kinds.join(", ") || "none"}`;
      const runLine = `${runs.length} ${runs.length === 1 ? "run" : "runs"}: ${runs.join(", ") || "none"}`;
      return new Text(
        `${theme.fg("muted", kindLine)}\n${theme.fg("muted", runLine)}`,
        0,
        0,
      );
    },
  });
}
