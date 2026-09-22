import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piSubagents from "../extensions/pi-subagents/index.ts";

interface TestContext {
  cwd: string;
  mode: "tui";
  isProjectTrusted(): boolean;
  ui: {
    setWidget(name: string, value: unknown): void;
    input(title: string, prompt: string): Promise<string | undefined>;
  };
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

test("Delegated Pi children leave subagent tools to the bridge", () => {
  const previousUrl = process.env.PI_SUBAGENTS_MCP_URL;
  process.env.PI_SUBAGENTS_MCP_URL = "http://127.0.0.1:1/mcp";
  let handlers = 0;
  let tools = 0;
  try {
    piSubagents({
      on() {
        handlers += 1;
      },
      registerTool() {
        tools += 1;
      },
    } as unknown as ExtensionAPI);
  } finally {
    if (previousUrl === undefined) delete process.env.PI_SUBAGENTS_MCP_URL;
    else process.env.PI_SUBAGENTS_MCP_URL = previousUrl;
  }
  assert.equal(handlers, 0);
  assert.equal(tools, 0);
});

test("Root delegation terminates its turn and wakes on each child completion", async () => {
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
  process.env.PATH = `${directory}:${previousPath ?? ""}`;

  const handlers = new Map<
    string,
    (event: unknown, context: TestContext) => unknown
  >();
  const tools = new Map<string, RegisteredTool>();
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
    sendMessage(message: Record<string, unknown>, options: unknown) {
      messages.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const widgets: unknown[] = [];
  const widgetRenders: string[][] = [];
  const inputs: Array<{ title: string; placeholder: string }> = [];
  const context: TestContext = {
    cwd: project,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
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
      "subagent",
      "subagent_list",
      "subagent_message",
    ]);
    await handlers.get("session_start")?.({}, context);
    const tool = tools.get("subagent");
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
      ["started slow (scout)"],
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
    assert.ok(widgets.some((value) => typeof value === "function"));
    await until(() => messages.length === 1);
    assert.deepEqual(messages[0], {
      message: {
        customType: "pi-subagents",
        content: "Subagent fast finished with status completed.\nFast done",
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
      ["1 kind: scout", "1 run: slow (scout) [running]"],
    );
    assert.ok(
      widgetRenders.some((lines) =>
        /total: 2  completed: 1  tokens: 11  cost: \$0.01/.test(lines[0] ?? ""),
      ),
    );
    await until(() => messages.length === 2);
    assert.deepEqual(messages[1], {
      message: {
        customType: "pi-subagents",
        content: "Subagent slow finished with status completed.\nSlow done",
        display: true,
      },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
    await until(() => widgets.at(-1) === undefined);
    assert.deepEqual(inputs, []);
    await handlers.get("session_shutdown")?.({}, context);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    await handlers.get("session_shutdown")?.({}, context);
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
