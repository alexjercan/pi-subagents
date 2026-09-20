import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  };
}

interface RegisteredTool {
  execute(
    id: string,
    params: { agent: string; task: string },
    signal: AbortSignal,
    onUpdate: undefined,
    context: TestContext,
  ): Promise<unknown>;
}

test("Extension shows active runs in a widget and clears it after completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-subagents-extension-"));
  const claude = join(directory, "claude");
  await writeFile(
    claude,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Inspecting" }], usage: { input_tokens: 4, output_tokens: 1 } } }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ type: "result", result: "Done", usage: { input_tokens: 4, output_tokens: 2 }, total_cost_usd: 0.01 }) + "\\n"), 20);
`,
  );
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ""}`;

  const handlers = new Map<
    string,
    (event: unknown, context: TestContext) => unknown
  >();
  let tool: RegisteredTool | undefined;
  const pi = {
    on(
      event: string,
      handler: (event: unknown, context: TestContext) => unknown,
    ) {
      handlers.set(event, handler);
    },
    registerTool(value: RegisteredTool) {
      tool = value;
    },
  } as unknown as ExtensionAPI;
  const widgets: unknown[] = [];
  const context: TestContext = {
    cwd: process.cwd(),
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      setWidget(_name, value) {
        widgets.push(value);
      },
    },
  };

  try {
    piSubagents(pi);
    await handlers.get("session_start")?.({}, context);
    assert.ok(tool);
    await tool.execute(
      "call",
      { agent: "scout", task: "Inspect" },
      new AbortController().signal,
      undefined,
      context,
    );
    assert.ok(widgets.some((value) => typeof value === "function"));
    assert.equal(widgets.at(-1), undefined);
    await handlers.get("session_shutdown")?.({}, context);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});
