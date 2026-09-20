import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createAgentRuntime,
  type AgentRunSnapshot,
  type AgentRuntime,
} from "./runtime.ts";

interface SubagentDetails {
  runs: AgentRunSnapshot[];
}

function formatRuns(runs: AgentRunSnapshot[]): string {
  const children = new Map<string | undefined, AgentRunSnapshot[]>();
  for (const run of runs) {
    const siblings = children.get(run.parentId) ?? [];
    siblings.push(run);
    children.set(run.parentId, siblings);
  }
  const lines: string[] = [];
  const append = (parentId: string | undefined, depth: number) => {
    for (const run of children.get(parentId) ?? []) {
      lines.push(`${"  ".repeat(depth)}${run.agent}: ${run.status}`);
      append(run.id, depth + 1);
    }
  };
  append(undefined, 0);
  return lines.join("\n");
}

export default function piSubagents(pi: ExtensionAPI): void {
  let runtime: AgentRuntime | undefined;
  const updates = new Set<
    (result: {
      content: Array<{ type: "text"; text: string }>;
      details: SubagentDetails;
    }) => void
  >();

  pi.on("session_start", async (_event, ctx) => {
    runtime = await createAgentRuntime({
      cwd: ctx.cwd,
      projectTrusted: ctx.isProjectTrusted(),
      onUpdate(runs) {
        const result = {
          content: [{ type: "text" as const, text: formatRuns(runs) }],
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
        return {
          content: [
            {
              type: "text",
              text: result.result?.finalText || "(no output)",
            },
          ],
          details: { runs: runtime.list() },
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
  });
}
