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

interface RegisteredTool {
  name: string;
  execute(
    id: string,
    params: Record<string, string>,
    signal: AbortSignal,
    onUpdate: undefined,
    context: TestContext,
  ): Promise<unknown>;
}

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("Extension exposes four async tools and clears completed runs", async () => {
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
process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Inspecting" }], usage: { input_tokens: 4, output_tokens: 1 } } }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "Done", usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.01 }) + "\\n"), 30);
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
  const messages: unknown[] = [];
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
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  const widgets: unknown[] = [];
  const context: TestContext = {
    cwd: project,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      setWidget(_name, value) {
        widgets.push(value);
      },
      input: async () => "answer",
    },
  };

  try {
    piSubagents(pi);
    assert.deepEqual([...tools.keys()].sort(), [
      "subagent",
      "subagent_ask",
      "subagent_list",
      "subagent_message",
    ]);
    await handlers.get("session_start")?.({}, context);
    const tool = tools.get("subagent");
    assert.ok(tool);
    await tool.execute(
      "call",
      { id: "inspection", name: "scout", prompt: "Inspect" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.ok(widgets.some((value) => typeof value === "function"));
    await until(() => widgets.at(-1) === undefined && messages.length === 1);
    assert.match(JSON.stringify(messages[0]), /Subagent inspection finished/);
    await handlers.get("session_shutdown")?.({}, context);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
