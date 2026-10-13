import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import {
  spawnHarness,
  type HarnessEvent,
} from "../extensions/pi-subagents/harness.ts";
import { normalizeClaudeRecord } from "../extensions/pi-subagents/harnesses/claude.ts";
import { spawnJsonlProcess } from "../extensions/pi-subagents/process.ts";

const claudeSessionId = "5f0c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";
let fixtureDirectory = "";
let previousPath = "";

const fixture = `#!/usr/bin/env node
const harness = process.argv[1].split("/").at(-1);
const args = process.argv.slice(2);
process.stderr.write(JSON.stringify({ args, disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, waitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS }) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const newline = input.indexOf("\\n");
    const command = JSON.parse(input.slice(0, newline));
    const prompt = command.message?.content ?? command.message;
    input = input.slice(newline + 1);
    if (harness === "pi" && command.type !== "extension_ui_response" && (command.type !== "prompt" || command.streamingBehavior !== "steer")) continue;
    if (prompt === "malformed") {
      process.stdout.write("not-json\\n");
      continue;
    }
    if (prompt === "exit-unsettled") {
      process.stderr.write("fatal: boom\\n", () => process.exit(7));
      continue;
    }
    if (prompt === "wait") continue;
    if (prompt === "reject") {
      process.stdout.write(JSON.stringify({ type: "response", command: "prompt", success: false, error: "Authentication failed" }) + "\\n");
      continue;
    }
    if (prompt === "pi-error" || prompt === "pi-retry") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "529 overloaded" } }) + "\\n");
      if (prompt === "pi-retry") process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "recovered" }], stopReason: "stop" } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      continue;
    }
    if (prompt === "dialog") {
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "notice", method: "notify", message: "hello" }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow?" }) + "\\n");
      continue;
    }
    if (command.type === "extension_ui_response") {
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(command) }] } }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
      continue;
    }
    if (prompt === "group") {
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => undefined);
      const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000)"], { stdio: "ignore" });
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "user", content: String(grandchild.pid) } }) + "\\n");
      continue;
    }
    const text = (fallback) => (prompt === "first" || prompt === "second" ? prompt + " report" : fallback);
    const events = harness === "pi" ? [
    { type: "tool_execution_start", toolCallId: "pi-call", toolName: "read", args: { path: "README.md" } },
    { type: "tool_execution_end", toolCallId: "pi-call", toolName: "read", result: { content: [{ type: "text", text: "read output" }] }, isError: false },
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: text("pi finished") }], usage: { input: 10, output: 2, cacheRead: 4, cacheWrite: 1, totalTokens: 17, cost: { total: 0.25 } } } },
    { type: "agent_settled" }
  ] : [
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "claude working" }, { type: "tool_use", id: "claude-call", name: "Read", input: { file_path: "README.md" } }], usage: { input_tokens: 12, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 } } },
    { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "claude-call", content: "read output", is_error: false }] } },
    { type: "result", subtype: "success", is_error: false, result: text("claude finished"), usage: { input_tokens: 12, output_tokens: 3, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 }, total_cost_usd: 0.5 }
  ];
    for (const event of events) process.stdout.write(JSON.stringify(event) + "\\n");
  }
});
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
    { system: "Inspect carefully.", tools: ["read", "grep"] },
    (event) => events.push(event),
  );
  const result = await run.completion;
  const invocation = JSON.parse(result.stderr) as { args: string[] };

  assert.equal(result.exitCode, 0);
  assert.equal(result.finalText, "pi finished");
  assert.deepEqual(invocation.args.slice(0, 7), [
    "--no-session",
    "--mode",
    "rpc",
    "--model",
    "openai/gpt-test",
    "--thinking",
    "medium",
  ]);
  assert.deepEqual(invocation.args.slice(7, 11), [
    "--append-system-prompt",
    "Inspect carefully.",
    "--tools",
    "read,grep",
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
  assert.deepEqual(events[3], {
    type: "usage",
    usage: {
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      contextTokens: 17,
      costUsd: 0.25,
      cumulative: false,
    },
  });
});

test("Claude emits messages, tool lifecycle, usage, and configured invocation", async () => {
  const events: HarnessEvent[] = [];
  const run = spawnHarness(
    {
      cwd: process.cwd(),
      prompt: "inspect",
      sessionId: claudeSessionId,
    },
    {
      harness: "claude",
      model: "sonnet",
      thinking: "high",
      permissionMode: "bypassPermissions",
    },
    {
      system: "Implement carefully.",
      tools: ["read", "ls", "find", "web_search"],
      delegation: {
        url: "http://127.0.0.1:1234/mcp",
        authorization: "Bearer secret",
      },
    },
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
  assert.deepEqual(invocation.args.slice(0, 9), [
    "--print",
    "--session-id",
    claudeSessionId,
    "--model",
    "sonnet",
    "--effort",
    "high",
    "--permission-mode",
    "bypassPermissions",
  ]);
  const systemIndex = invocation.args.indexOf("--append-system-prompt");
  assert.deepEqual(invocation.args.slice(systemIndex, systemIndex + 4), [
    "--append-system-prompt",
    "Implement carefully.",
    "--tools",
    "Read,Glob,WebSearch",
  ]);
  assert.ok(invocation.args.includes("--input-format"));
  assert.ok(invocation.args.includes("stream-json"));
  const mcpConfig = JSON.parse(
    invocation.args[invocation.args.indexOf("--mcp-config") + 1] ?? "",
  ) as Record<string, unknown>;
  assert.deepEqual(mcpConfig, {
    mcpServers: {
      pi_subagents: {
        type: "http",
        url: "http://127.0.0.1:1234/mcp",
        headers: { Authorization: "Bearer secret" },
        timeout: 2147483647,
      },
    },
  });
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  const disallowedIndex = invocation.args.indexOf("--disallowedTools");
  assert.deepEqual(
    invocation.args.slice(disallowedIndex, disallowedIndex + 2),
    ["--disallowedTools", "Task,Agent,AskUserQuestion"],
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["message", "tool_start", "usage", "message", "tool_end", "usage"],
  );
  assert.deepEqual(events[2], {
    type: "usage",
    usage: {
      inputTokens: 12,
      outputTokens: 2,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      contextTokens: 20,
      cumulative: false,
    },
  });
  assert.deepEqual(events[4], {
    type: "tool_end",
    id: "claude-call",
    name: "Read",
    output: "read output",
    isError: false,
  });
  assert.deepEqual(events[5], {
    type: "usage",
    usage: {
      inputTokens: 12,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      costUsd: 0.5,
      cumulative: true,
    },
  });
});

test("Claude refuses to launch without a session id", () => {
  assert.throws(
    () =>
      spawnHarness(
        { cwd: process.cwd(), prompt: "inspect" },
        {
          harness: "claude",
          model: "sonnet",
          thinking: "high",
          permissionMode: "bypassPermissions",
        },
        { system: "Inspect." },
        () => undefined,
      ),
    /^Error: Claude harness requires a session id$/,
  );
});

test("A harness can accept another prompt after a settled turn", async () => {
  let turns = 0;
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    {
      cwd: process.cwd(),
      prompt: "first",
      sessionId: claudeSessionId,
    },
    {
      harness: "claude",
      model: "haiku",
      thinking: "low",
      permissionMode: "bypassPermissions",
    },
    {
      system: "Reply briefly.",
      onTurnSettled: () => {
        turns += 1;
        if (turns === 1) {
          finishFirstTurn();
          return false;
        }
        return true;
      },
    },
    () => undefined,
  );
  try {
    await firstTurn;
    await run.send("second");
    const result = await run.completion;
    assert.equal(turns, 2);
    assert.equal(result.finalText, "first report\n\nsecond report");
    assert.equal(result.exitCode, 0);
  } finally {
    run.stop();
  }
});

test("An idle Pi harness resumes when sent a second prompt", async () => {
  let turns = 0;
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "first" },
    { harness: "pi", model: "openai/gpt-test", thinking: "medium" },
    {
      system: "Reply briefly.",
      onTurnSettled: () => {
        turns += 1;
        if (turns === 1) {
          finishFirstTurn();
          return false;
        }
        return true;
      },
    },
    () => undefined,
  );
  try {
    await firstTurn;
    await run.send("second");
    const result = await Promise.race([
      run.completion,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Idle Pi harness did not resume")),
          500,
        ),
      ),
    ]);
    assert.equal(turns, 2);
    assert.equal(result.finalText, "first report\n\nsecond report");
    assert.equal(result.exitCode, 0);
  } finally {
    run.stop();
  }
});

test("Malformed harness output rejects completion", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "malformed" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, SyntaxError);
});

test("An unsolicited clean exit before settlement fails loudly", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "exit-unsettled" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(
    run.completion,
    /^Error: Harness exited with code 7 before reporting completion\n[^]*fatal: boom$/,
  );
});

test("A running harness accepts a steering message", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "wait" },
    { harness: "pi", model: "openai/gpt-test", thinking: "medium" },
    { system: "Wait." },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await run.send("continue");
  const result = await run.completion;
  assert.equal(result.finalText, "pi finished");
});

test("Stopping a harness terminates its process", async () => {
  const run = spawnHarness(
    {
      cwd: process.cwd(),
      prompt: "wait",
      sessionId: claudeSessionId,
    },
    {
      harness: "claude",
      model: "sonnet",
      thinking: "medium",
      permissionMode: "bypassPermissions",
    },
    { system: "Wait." },
    () => undefined,
  );
  run.stop();
  const result = await run.completion;
  assert.equal(result.signal, "SIGTERM");
});

test("Claude forwards the configured permission mode", async () => {
  const run = spawnHarness(
    {
      cwd: process.cwd(),
      prompt: "inspect",
      sessionId: claudeSessionId,
    },
    {
      harness: "claude",
      model: "sonnet",
      thinking: "high",
      permissionMode: "auto",
    },
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  const invocation = JSON.parse(result.stderr) as { args: string[] };
  const index = invocation.args.indexOf("--permission-mode");
  assert.deepEqual(invocation.args.slice(index, index + 2), [
    "--permission-mode",
    "auto",
  ]);
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("Claude turn errors carry the reported errors", () => {
  assert.deepEqual(
    normalizeClaudeRecord({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      errors: ["Reached maximum number of turns (3)"],
    }),
    {
      events: [],
      finalText: undefined,
      error: "Reached maximum number of turns (3)",
      settled: true,
    },
  );
  assert.deepEqual(
    normalizeClaudeRecord({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "API Error: 529 overloaded",
    }),
    {
      events: [],
      finalText: "API Error: 529 overloaded",
      error: "API Error: 529 overloaded",
      settled: true,
    },
  );
});

test("A rejected Pi prompt fails the run and stops the harness", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "reject" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, /^Error: Authentication failed$/);
});

test("A Pi turn that ends with an error fails the run", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "pi-error" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, /^Error: 529 overloaded$/);
});

test("A failed later turn keeps the reports of earlier turns", async () => {
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "first" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    {
      system: "Inspect.",
      onTurnSettled: () => {
        finishFirstTurn();
        return false;
      },
    },
    () => undefined,
  );
  await firstTurn;
  await run.send("pi-error");
  await assert.rejects(
    run.completion,
    /^Error: 529 overloaded\n\nfirst report$/,
  );
});

test("A Pi turn that recovers after a retried error completes", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "pi-retry" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  assert.equal(result.finalText, "recovered");
  assert.equal(result.finished, true);
});

test("Pi dialog requests are answered as cancelled", async () => {
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "dialog" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  assert.deepEqual(JSON.parse(result.finalText), {
    type: "extension_ui_response",
    id: "ui-1",
    cancelled: true,
  });
});

test("Stopping a harness kills its process group after the grace period", async () => {
  let grandchild = 0;
  const run = spawnHarness(
    { cwd: process.cwd(), prompt: "group" },
    { harness: "pi", model: "openai/gpt-test", thinking: "low" },
    { system: "Inspect." },
    (event) => {
      if (event.type === "message") grandchild = Number(event.message.content);
    },
  );
  while (!grandchild) await new Promise((resolve) => setTimeout(resolve, 5));
  const started = Date.now();
  run.stop();
  const result = await run.completion;
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started >= 4900);
  while (alive(grandchild))
    await new Promise((resolve) => setTimeout(resolve, 5));
});

test("Writing to a harness that closed its input rejects instead of crashing", async () => {
  const run = spawnJsonlProcess(
    { command: "sh", args: ["-c", "exec 0<&-; sleep 1"], cwd: process.cwd() },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(run.send({ value: "x".repeat(200000) }), /EPIPE/);
  await assert.rejects(run.send({ value: "again" }), /EPIPE/);
  run.stop();
  await run.completion;
});

test("Root process exit kills live harness process groups", async () => {
  const processModule = new URL(
    "../extensions/pi-subagents/process.ts",
    import.meta.url,
  ).href;
  const root = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { spawnJsonlProcess } from ${JSON.stringify(processModule)};
const run = spawnJsonlProcess({ command: "sh", args: ["-c", "trap '' TERM; sleep 1000 & wait"], cwd: process.cwd() }, () => undefined);
process.stdout.write(String(run.pid) + "\\n", () => { throw new Error("root crashed"); });`,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  let output = "";
  root.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exitCode = await new Promise<number | null>((resolve) =>
    root.once("close", resolve),
  );
  const harness = Number(output.trim());
  const deadline = Date.now() + 2000;
  while (alive(harness) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  const survived = alive(harness);
  if (survived) process.kill(-harness, "SIGKILL");
  assert.equal(exitCode, 1);
  assert.ok(harness > 0);
  assert.equal(survived, false);
});
