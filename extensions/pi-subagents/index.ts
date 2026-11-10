import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  createAgentRuntime,
  type AgentInventory,
  type AgentRunSnapshot,
  type AgentRuntime,
} from "./runtime.ts";
import { registerPiTools, type ToolRenderers } from "./pi-tools.ts";
import { OWNER_TOOLS, type ToolResult } from "./tools.ts";
import {
  activeAgentTree,
  PLAIN_THEME,
  renderAgentTree,
  renderRunDetails,
  renderRunLine,
  renderViewport,
  type AgentTreeTheme,
} from "./ui.ts";

const DETAILS_HEIGHT = 20;

interface SubagentDetails {
  run?: Pick<AgentRunSnapshot, "id" | "agent">;
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

export function sessionsDirectory(home: string, cwd: string): string {
  return join(
    home,
    ".pi",
    "agent",
    "subagents",
    cwd.replace(/[^A-Za-z0-9._-]/g, "-"),
  );
}

function text(value: string, details?: SubagentDetails): ToolResult {
  return { content: [{ type: "text", text: value }], details };
}

function required(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  return value;
}

function words(args: string, count: number): string[] {
  const values: string[] = [];
  let rest = args.trim();
  while (values.length < count && rest.length > 0) {
    const end = rest.search(/\s/);
    if (end === -1) {
      values.push(rest);
      rest = "";
      break;
    }
    values.push(rest.slice(0, end));
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) values.push(rest);
  return values;
}

function rootRuns(runtime: AgentRuntime): AgentRunSnapshot[] {
  return runtime.list().filter((run) => run.parentRunId === undefined);
}

function selectable(run: AgentRunSnapshot): boolean {
  return (
    run.status === "running" ||
    run.status === "waiting" ||
    run.status === "idle"
  );
}

function renderMuted(
  result: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  },
  theme: Theme,
): Text {
  const content = result.content[0];
  const value = content?.type === "text" ? content.text : "(no output)";
  const details = result.details as SubagentDetails | undefined;
  return new Text(
    theme.fg(details?.error ? "error" : "muted", value ?? "(no output)"),
    0,
    0,
  );
}

const renderers: ToolRenderers = {
  subagent_message: {
    renderResult: (result, _options, theme) => renderMuted(result, theme),
  },
  subagent_stop: {
    renderResult: (result, _options, theme) => renderMuted(result, theme),
  },
  subagent_wait: {
    renderResult: (result, _options, theme) => renderMuted(result, theme),
  },
  subagent_create: {
    renderCall(args, theme) {
      const { id, name } = args as Record<string, unknown>;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("subagent_create"))} ${theme.fg("accent", String(id))} ${theme.fg("muted", String(name))}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const content = result.content[0];
      const fallback = content?.type === "text" ? content.text : "(no output)";
      const details = result.details as SubagentDetails | undefined;
      if (details?.error) return new Text(theme.fg("error", fallback), 0, 0);
      const run = details?.run;
      if (!run) return new Text(fallback, 0, 0);
      return new Text(
        `${theme.fg("success", "created")} ${theme.fg("accent", run.id)} ${theme.fg("muted", `(${run.agent})`)}`,
        0,
        0,
      );
    },
  },
  subagent_list: {
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
  },
};

export default function piSubagents(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENTS_RUN_ID) return;

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
      sessionsDir: sessionsDirectory(homedir(), ctx.cwd),
      onUpdate: setWidget,
      onRootQuestion(id, prompt) {
        wakeOwner(
          `Subagent ${id} is waiting for an answer.\nQuestion: ${prompt}\nAnswer it with subagent_message using id ${id}.`,
        );
      },
      onRootMessage(message) {
        wakeOwner(message);
      },
      onEntry(entry) {
        pi.appendEntry("pi-subagents", entry);
      },
    });
  });

  const fail = (ctx: ExtensionCommandContext, error: unknown) =>
    ctx.ui.notify(
      error instanceof Error ? error.message : String(error),
      "error",
    );
  const requireRuntime = (): AgentRuntime => {
    if (!runtime) throw new Error("Subagent runtime is not running");
    return runtime;
  };
  const chooseId = async (
    ctx: ExtensionCommandContext,
    title: string,
  ): Promise<string | undefined> => {
    if (!ctx.hasUI) throw new Error("Subagent id is required");
    const runs = rootRuns(requireRuntime()).filter(selectable);
    if (runs.length === 0) throw new Error("No root subagents");
    const labels = runs.map(
      (run) => `${run.id} (${run.agent}) [${run.status}]`,
    );
    const chosen = await ctx.ui.select(title, labels);
    if (chosen === undefined) return undefined;
    return runs[labels.indexOf(chosen)]?.id;
  };
  const command = (
    name: string,
    description: string,
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>,
  ) =>
    pi.registerCommand(name, {
      description,
      async handler(args, ctx) {
        try {
          await handler(args, ctx);
        } catch (error) {
          fail(ctx, error);
        }
      },
    });

  command("subagent-list", "List root subagents", async (_args, ctx) => {
    const runs = rootRuns(requireRuntime());
    if (runs.length === 0) {
      ctx.ui.notify("No root subagents", "info");
      return;
    }
    const now = Date.now();
    ctx.ui.notify(
      runs.map((run) => renderRunLine(run, PLAIN_THEME, now)).join("\n"),
      "info",
    );
  });

  command(
    "subagent-show",
    "Show one root subagent: /subagent-show <id>",
    async (args, ctx) => {
      const [requested] = words(args, 1);
      const id = requested ?? (await chooseId(ctx, "Show subagent"));
      if (id === undefined) return;
      const run = rootRuns(requireRuntime()).find(
        (candidate) => candidate.id === id,
      );
      if (!run) throw new Error(`Unknown root subagent ${id}`);
      const now = Date.now();
      if (ctx.mode !== "tui") {
        ctx.ui.notify(renderRunDetails(run, PLAIN_THEME, now), "info");
        return;
      }
      await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
        const details = renderRunDetails(run, colors(theme), now);
        let top = 0;
        return {
          render(width) {
            const view = renderViewport(details, top, DETAILS_HEIGHT, width);
            top = view.top;
            const end = Math.min(view.top + DETAILS_HEIGHT, view.total);
            return [
              ...view.lines,
              theme.fg(
                "dim",
                `lines ${view.total === 0 ? 0 : view.top + 1}-${end} of ${view.total}  up/down scroll, enter or escape closes`,
              ),
            ];
          },
          handleInput(data: string) {
            if (keybindings.matches(data, "tui.select.up")) top -= 1;
            else if (keybindings.matches(data, "tui.select.down")) top += 1;
            else if (keybindings.matches(data, "tui.select.pageUp"))
              top -= DETAILS_HEIGHT;
            else if (keybindings.matches(data, "tui.select.pageDown"))
              top += DETAILS_HEIGHT;
            else if (
              keybindings.matches(data, "tui.select.confirm") ||
              keybindings.matches(data, "tui.select.cancel")
            ) {
              done();
              return;
            } else return;
            tui.requestRender();
          },
          invalidate() {},
        };
      });
    },
  );

  command(
    "subagent-create",
    "Create a root subagent: /subagent-create <name> <id> <prompt>",
    async (args, ctx) => {
      const [name, id, prompt] = words(args, 2);
      if (!name || !id || !prompt)
        throw new Error("Usage: /subagent-create <name> <id> <prompt>");
      const run = await requireRuntime().create({ id, name, prompt });
      ctx.ui.notify(`Created subagent ${run.id} using ${run.agent}`, "info");
    },
  );

  command(
    "subagent-message",
    "Message a root subagent: /subagent-message <id> <text>",
    async (args, ctx) => {
      const [requested, given] = words(args, 1);
      const id = requested ?? (await chooseId(ctx, "Message subagent"));
      if (id === undefined) return;
      const text =
        given ?? (ctx.hasUI ? await ctx.ui.input(`Message to ${id}`) : "");
      if (text === undefined) return;
      if (!text) throw new Error("Usage: /subagent-message <id> <text>");
      await requireRuntime().message(undefined, id, text);
      ctx.ui.notify(`Message sent to ${id}`, "info");
    },
  );

  command(
    "subagent-stop",
    "Stop a root subagent: /subagent-stop <id>",
    async (args, ctx) => {
      const [requested] = words(args, 1);
      const id = requested ?? (await chooseId(ctx, "Stop subagent"));
      if (id === undefined) return;
      const run = await requireRuntime().stop(undefined, id);
      ctx.ui.notify(`Subagent ${run.id} is ${run.status}`, "info");
    },
  );

  pi.on("session_shutdown", async () => {
    const current = runtime;
    runtime = undefined;
    clearWidget();
    clearWidget = () => undefined;
    await current?.close();
  });

  registerPiTools(
    pi,
    OWNER_TOOLS,
    async (name, args, signal) => {
      if (!runtime) throw new Error("Subagent runtime is not running");
      switch (name) {
        case "subagent_create": {
          const run = await runtime.create({
            id: required(args, "id"),
            name: required(args, "name"),
            prompt: required(args, "prompt"),
          });
          return {
            ...text(`Created subagent ${run.id} using ${run.agent}`, {
              run: { id: run.id, agent: run.agent },
            }),
            terminate: true,
          };
        }
        case "subagent_message": {
          const id = required(args, "id");
          await runtime.message(undefined, id, required(args, "message"));
          return { ...text(`Message sent to ${id}`), terminate: true };
        }
        case "subagent_wait": {
          const ids = Array.isArray(args.ids)
            ? args.ids.map(String)
            : undefined;
          const notices = await runtime.wait(
            undefined,
            ids,
            signal ?? new AbortController().signal,
          );
          return text(notices.join("\n\n"));
        }
        case "subagent_stop": {
          const run = await runtime.stop(undefined, required(args, "id"));
          return {
            ...text(`Subagent ${run.id} is ${run.status}`),
            terminate: true,
          };
        }
        case "subagent_list": {
          const inventory = await runtime.inventory();
          return text(JSON.stringify(inventory), { inventory });
        }
        case "subagent_ask":
          throw new Error("The root session has no owner to ask");
      }
    },
    renderers,
  );
}
