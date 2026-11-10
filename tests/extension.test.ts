import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piSubagents from "../extensions/pi-subagents/index.ts";
import type { SubagentLogEntry } from "../extensions/pi-subagents/runtime.ts";

interface TestContext {
  cwd: string;
  mode: "tui";
  hasUI: boolean;
  isProjectTrusted(): boolean;
  ui: {
    setWidget(name: string, value: unknown): void;
    input(title: string, prompt: string): Promise<string | undefined>;
    notify(message: string, type?: string): void;
    select(title: string, options: string[]): Promise<string | undefined>;
    custom<T>(factory: TestCustomFactory<T>): Promise<T>;
  };
}

interface TestCustomComponent {
  render(width: number): string[];
  handleInput(data: string): void;
}

type TestCustomFactory<T> = (
  tui: { requestRender(): void },
  theme: TestTheme,
  keybindings: { matches(data: string, id: string): boolean },
  done: (result: T) => void,
) => TestCustomComponent;

interface RegisteredCommand {
  description?: string;
  handler(args: string, ctx: TestContext): Promise<void>;
}

interface TestToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
}

interface TestTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface TestWidget {
  render(width: number): string[];
}

type TestWidgetFactory = (tui: unknown, theme: TestTheme) => TestWidget;

interface RegisteredTool {
  name: string;
  execute(
    id: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: TestContext,
  ): Promise<TestToolResult>;
  renderResult?(
    result: TestToolResult,
    options: { isPartial: boolean },
    theme: TestTheme,
  ): { render(width: number): string[] };
}

const theme: TestTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("Pi children load neither the runtime, the tools, nor the commands", () => {
  const previousRunId = process.env.PI_SUBAGENTS_RUN_ID;
  process.env.PI_SUBAGENTS_RUN_ID = "child-run";
  let handlers = 0;
  let tools = 0;
  let commands = 0;
  try {
    piSubagents({
      on() {
        handlers += 1;
      },
      registerTool() {
        tools += 1;
      },
      registerCommand() {
        commands += 1;
      },
    } as unknown as ExtensionAPI);
  } finally {
    if (previousRunId === undefined) delete process.env.PI_SUBAGENTS_RUN_ID;
    else process.env.PI_SUBAGENTS_RUN_ID = previousRunId;
  }
  assert.equal(handlers, 0);
  assert.equal(tools, 0);
  assert.equal(commands, 0);
});

test("Root delegation wakes on completion without persisting agent event histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-extension-"));
  const project = join(directory, "project");
  await mkdir(join(project, ".pi"), { recursive: true });
  await writeFile(
    join(project, ".pi", "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    tools: [read]
    system: Inspect the project.
`,
  );
  const claude = join(directory, "claude");
  await writeFile(
    claude,
    `#!/usr/bin/env node
process.stdin.once("data", (chunk) => {
  const command = JSON.parse(String(chunk).split("\\n")[0]);
  const prompt = command.message?.content ?? "";
  const delay = prompt === "Slow" ? 300 : 20;
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Inspecting" }], usage: { input_tokens: 4, output_tokens: 1 } } }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: prompt + " done", usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.01 }) + "\\n"), delay);
});
`,
  );
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  const previousHome = process.env.HOME;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
  process.env.HOME = directory;

  const handlers = new Map<
    string,
    (event: unknown, context: TestContext) => unknown
  >();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const entries: Array<{ type: string; entry: SubagentLogEntry }> = [];
  const messages: Array<{
    message: Record<string, unknown>;
    options: unknown;
  }> = [];
  const pi = {
    on(
      event: string,
      handler: (event: unknown, context: TestContext) => unknown,
    ) {
      handlers.set(event, handler);
    },
    registerTool(value: RegisteredTool) {
      tools.set(value.name, value);
    },
    registerCommand(name: string, value: RegisteredCommand) {
      commands.set(name, value);
    },
    appendEntry(type: string, entry: SubagentLogEntry) {
      entries.push({ type, entry });
    },
    sendMessage(message: Record<string, unknown>, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const widgets: unknown[] = [];
  const widgetRenders: string[][] = [];
  const inputs: Array<{ title: string; placeholder: string }> = [];
  const notices: Array<{ message: string; type?: string }> = [];
  const customRenders: string[][] = [];
  const context: TestContext = {
    cwd: project,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    ui: {
      notify(message, type) {
        notices.push({ message, type });
      },
      select: async () => undefined,
      async custom(factory) {
        return await new Promise((resolve) => {
          const component = factory(
            { requestRender() {} },
            theme,
            { matches: (data, id) => data === id },
            resolve,
          );
          customRenders.push(component.render(120));
          component.handleInput("tui.select.cancel");
        });
      },
      setWidget(_name, value) {
        widgets.push(value);
        if (typeof value === "function")
          widgetRenders.push(
            (value as TestWidgetFactory)(undefined, theme).render(120),
          );
      },
      input: async (title, placeholder) => {
        inputs.push({ title, placeholder });
        return "answer";
      },
    },
  };

  try {
    piSubagents(pi);
    assert.deepEqual([...tools.keys()].sort(), [
      "subagent_create",
      "subagent_list",
      "subagent_message",
      "subagent_stop",
      "subagent_wait",
    ]);
    assert.deepEqual([...commands.keys()].sort(), [
      "subagent-create",
      "subagent-list",
      "subagent-message",
      "subagent-show",
      "subagent-stop",
    ]);
    await handlers.get("session_start")?.({}, context);
    assert.ok(
      existsSync(
        join(
          directory,
          ".pi",
          "agent",
          "subagents",
          project.replace(/[^A-Za-z0-9._-]/g, "-"),
        ),
      ) === false,
    );
    const tool = tools.get("subagent_create");
    assert.ok(tool);
    const slow = await tool.execute(
      "slow-call",
      { id: "slow", name: "scout", prompt: "Slow" },
      new AbortController().signal,
      undefined,
      context,
    );
    const fast = await tool.execute(
      "fast-call",
      { id: "fast", name: "scout", prompt: "Fast" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(slow.terminate, true);
    assert.equal(fast.terminate, true);
    assert.deepEqual(
      tool
        .renderResult?.(slow, { isPartial: false }, theme)
        .render(120)
        .map((line) => line.trimEnd()),
      ["created slow (scout)"],
    );
    const listTool = tools.get("subagent_list");
    assert.ok(listTool);
    const listed = await listTool.execute(
      "list-call",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    const listLines = listTool
      .renderResult?.(listed, { isPartial: false }, theme)
      .render(120)
      .map((line) => line.trimEnd());
    assert.deepEqual(listLines, [
      "1 kind: scout",
      "2 runs: slow (scout) [running], fast (scout) [running]",
    ]);
    assert.ok(listLines?.every((line) => !line.includes("{")));
    assert.ok(
      existsSync(
        join(
          directory,
          ".pi",
          "agent",
          "subagents",
          project.replace(/[^A-Za-z0-9._-]/g, "-"),
        ),
      ),
    );
    assert.ok(widgets.some((value) => typeof value === "function"));
    await until(() => messages.length >= 1);
    assert.deepEqual(messages[0], {
      message: {
        customType: "pi-subagents",
        content: "Subagent fast is idle.\nFast done",
        display: true,
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
    const pending = await listTool.execute(
      "pending-call",
      {},
      new AbortController().signal,
      undefined,
      context,
    );
    assert.deepEqual(
      listTool
        .renderResult?.(pending, { isPartial: false }, theme)
        .render(120)
        .map((line) => line.trimEnd()),
      ["1 kind: scout", "2 runs: slow (scout) [running], fast (scout) [idle]"],
    );
    assert.ok(
      widgetRenders.some((lines) =>
        /total: 2  ended: 1  tokens: 11  cost: \$0.01/.test(lines[0] ?? ""),
      ),
    );
    const messageTool = tools.get("subagent_message");
    assert.ok(messageTool);
    const sent = await messageTool.execute(
      "message-call",
      { id: "slow", message: "Continue" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(sent.terminate, true);
    await until(() => messages.length >= 2);
    assert.deepEqual(messages[1], {
      message: {
        customType: "pi-subagents",
        content: "Subagent slow is idle.\nSlow done",
        display: true,
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
    await until(() => widgets.at(-1) === undefined);
    const stoppedRun = await tool.execute(
      "stopped-call",
      { id: "stopped", name: "scout", prompt: "Slow" },
      new AbortController().signal,
      undefined,
      context,
    );
    const stopTool = tools.get("subagent_stop");
    assert.ok(stopTool);
    const stopped = await stopTool.execute(
      "stop-call",
      { id: "stopped" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.equal(stopped.terminate, true);
    for (const result of [
      slow,
      fast,
      listed,
      pending,
      sent,
      stoppedRun,
      stopped,
    ]) {
      assert.ok(JSON.stringify(result).length < 10_000);
      assert.ok(!JSON.stringify(result.details ?? {}).includes('"events"'));
    }
    assert.deepEqual(inputs, []);

    const fastEntries = entries.filter(
      ({ type, entry }) => type === "pi-subagents" && entry.id === "fast",
    );
    assert.deepEqual(
      fastEntries.map(({ entry }) => entry.event),
      ["create", "idle"],
    );
    const [created, idle] = fastEntries.map(({ entry }) => entry);
    assert.ok(created && idle);
    assert.equal(created.text, "Fast");
    assert.ok((created.pid ?? 0) > 0);
    assert.equal(idle.text, "Fast done");
    assert.equal(idle.runId, created.runId);
    assert.deepEqual(idle.usage, {
      inputTokens: 4,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 5,
      costUsd: 0.01,
    });
    assert.equal(
      idle.session,
      join(
        directory,
        ".claude",
        "projects",
        project.replace(/[^A-Za-z0-9]/g, "-"),
        `${idle.runId}.jsonl`,
      ),
    );
    assert.deepEqual(
      entries
        .filter(({ entry }) => entry.id === "stopped")
        .map(({ entry }) => entry.event),
      ["create", "stop"],
    );

    await commands
      .get("subagent-create")
      ?.handler("scout created Slow prompt text", context);
    assert.deepEqual(notices.at(-1), {
      message: "Created subagent created using scout",
      type: "info",
    });
    assert.equal(
      entries.filter(({ entry }) => entry.id === "created")[0]?.entry.text,
      "Slow prompt text",
    );
    await commands.get("subagent-list")?.handler("", context);
    const listing = notices.at(-1)?.message.split("\n") ?? [];
    assert.ok(
      listing.some((line) =>
        /^\[>\] created \(scout\) \[running\] 00:0\d/.test(line),
      ),
    );
    assert.ok(
      listing.some((line) =>
        /^\[ok\] fast \(scout\) \[idle\] 00:0\d .* Fast done$/.test(line),
      ),
    );
    await commands.get("subagent-show")?.handler("created", context);
    const shown = customRenders.at(-1) ?? [];
    assert.ok(
      shown.some((line) => line.startsWith("[>] created (scout) [running]")),
    );
    assert.ok(shown.includes("session:"));
    assert.ok(shown.some((line) => line.endsWith(".jsonl")));
    assert.ok(shown.at(-1)?.startsWith("lines 1-13 of 13"));
    assert.ok(shown.some((line) => /^pid: [1-9]\d*$/.test(line)));
    await commands.get("subagent-show")?.handler("missing", context);
    assert.deepEqual(notices.at(-1), {
      message: "Unknown root subagent missing",
      type: "error",
    });
    await commands.get("subagent-stop")?.handler("created", context);
    assert.deepEqual(notices.at(-1), {
      message: "Subagent created is stopped",
      type: "info",
    });
    await commands.get("subagent-create")?.handler("scout", context);
    assert.deepEqual(notices.at(-1), {
      message: "Usage: /subagent-create <name> <id> <prompt>",
      type: "error",
    });

    await handlers.get("session_shutdown")?.({}, context);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    await handlers.get("session_shutdown")?.({}, context);
    process.env.PATH = previousPath;
    process.env.HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
