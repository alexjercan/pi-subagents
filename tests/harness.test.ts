import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import {
  spawnHarness,
  type HarnessEvent,
} from "../extensions/pi-subagents/harness.ts";

let fixtureDirectory = "";
let previousPath = "";

const fixture = `#!/usr/bin/env node
const harness = process.argv[1].split("/").at(-1);
const args = process.argv.slice(2);
const prompt = args.at(-1);
process.stderr.write(JSON.stringify({ args, disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, waitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }) + "\\n");
if (prompt === "malformed") {
  process.stdout.write("not-json\\n");
} else if (prompt === "wait") {
  setInterval(() => undefined, 1000);
} else {
  const events = harness === "pi" ? [
    { type: "tool_execution_start", toolCallId: "pi-call", toolName: "read", args: { path: "README.md" } },
    { type: "tool_execution_end", toolCallId: "pi-call", toolName: "read", result: { content: [{ type: "text", text: "read output" }] }, isError: false },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "pi finished" }], usage: { input: 10, output: 2 } } }
  ] : [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "claude working" }, { type: "tool_use", id: "claude-call", name: "Read", input: { file_path: "README.md" } }], usage: { input_tokens: 12 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-call", content: "read output", is_error: false }] } },
    { type: "result", result: "claude finished", usage: { output_tokens: 3 } }
  ];
  for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
}
`;

before(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "pi-subagents-harness-"));
  previousPath = process.env.PATH ?? "";
  for (const name of ["pi", "claude"]) {
    const path = join(fixtureDirectory, name);
    await writeFile(path, fixture);
    await chmod(path, 0o755);
  }
  process.env.PATH = `${fixtureDirectory}:${previousPath}`;
});

after(async () => {
  process.env.PATH = previousPath;
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("Pi emits messages, tool lifecycle, usage, and configured arguments", async () => {
  const events: HarnessEvent[] = [];
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "inspect" },
    { harness: "pi", model: "openai/gpt-test", thinking: "medium" },
    (event) => events.push(event),
  );
  const result = await run.completion;
  const invocation = JSON.parse(result.stderr) as { args: string[] };

  assert.equal(result.exitCode, 0);
  assert.equal(result.finalText, "pi finished");
  assert.deepEqual(invocation.args.slice(0, 8), [
    "--print",
    "--no-session",
    "--mode",
    "json",
    "--model",
    "openai/gpt-test",
    "--thinking",
    "medium",
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["tool_start", "tool_end", "message", "usage"],
  );
  assert.deepEqual(events[0], {
    type: "tool_start",
    id: "pi-call",
    name: "read",
    input: { path: "README.md" },
  });
});

test("Claude emits messages, tool lifecycle, usage, and configured invocation", async () => {
  const events: HarnessEvent[] = [];
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "inspect" },
    { harness: "claude", model: "sonnet", thinking: "high" },
    (event) => events.push(event),
  );
  const result = await run.completion;
  const invocation = JSON.parse(result.stderr) as {
    args: string[];
    disableBackgroundTasks: string;
    waitCeiling: string;
  };

  assert.equal(result.exitCode, 0);
  assert.equal(result.finalText, "claude finished");
  assert.equal(invocation.disableBackgroundTasks, "1");
  assert.equal(invocation.waitCeiling, "0");
  assert.deepEqual(invocation.args.slice(0, 8), [
    "--print",
    "--no-session-persistence",
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.deepEqual(
    events.map((event) => event.type),
    ["message", "tool_start", "usage", "message", "tool_end", "usage"],
  );
  assert.deepEqual(events[4], {
    type: "tool_end",
    id: "claude-call",
    name: "Read",
    output: "read output",
    isError: false,
  });
});

test("Malformed harness output rejects completion", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "malformed" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    () => undefined,
  );
  await assert.rejects(run.completion, SyntaxError);
});

test("Stopping a harness terminates its process", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "wait" },
    { harness: "claude", model: "sonnet", thinking: "medium" },
    () => undefined,
  );
  run.stop();
  const result = await run.completion;
  assert.equal(result.signal, "SIGTERM");
});
