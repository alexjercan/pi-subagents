import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test, { after, before } from "node:test";
import {
  spawnHarness,
  type HarnessConfig,
  type HarnessDelegation,
  type HarnessEvent,
  type HarnessRequest,
} from "../extensions/pi-subagents/harness.ts";
import { normalizeClaudeRecord } from "../extensions/pi-subagents/harnesses/claude.ts";
import { spawnJsonlProcess } from "../extensions/pi-subagents/process.ts";
import {
  createToolServer,
  type DelegationOperations,
} from "../extensions/pi-subagents/tools.ts";
import { claudeFixture, installExecutables, stderrLines } from "./fixtures.ts";

const runId = "5f0c2d1e-8a4b-4c3d-9e2f-1a2b3c4d5e6f";
let fixtureDirectory = "";
let previousPath = "";

const claudeConfig: HarnessConfig = {
  harness: "claude",
  model: "sonnet",
  thinking: "high",
  permissionMode: "bypassPermissions",
};
const piConfig: HarnessConfig = {
  harness: "pi",
  model: "openai/gpt-test",
  thinking: "medium",
};

function request(prompt: string, resume = false): HarnessRequest {
  return {
    cwd: process.cwd(),
    prompt,
    runId,
    resume,
    sessionsDir: fixtureDirectory,
  };
}

function operations(
  overrides: Partial<DelegationOperations> = {},
): DelegationOperations {
  return {
    create: async () => ({ status: "running" }),
    message: async () => ({ status: "running" }),
    wait: async () => [],
    stop: async () => ({ status: "stopped" }),
    list: async () => ({ kinds: [], runs: [] }),
    ask: async () => "answer",
    ...overrides,
  };
}

function delegation(
  overrides: Partial<DelegationOperations> = {},
): HarnessDelegation {
  return {
    http: () => ({
      url: "http://127.0.0.1:1234/mcp",
      authorization: "Bearer secret",
    }),
    server: () =>
      createToolServer(operations(overrides), {
        callerRunId: runId,
        agents: new Set(["scout"]),
      }),
  };
}

const fixture = `#!/usr/bin/env node
const harness = process.argv[1].split("/").at(-1);
const args = process.argv.slice(2);
process.stderr.write(JSON.stringify({ args, disableBackgroundTasks: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, waitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, noPrefix: process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX }) + "\\n");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const newline = input.indexOf("\\n");
    const command = JSON.parse(input.slice(0, newline));
    const prompt = command.message?.content ?? command.message;
    input = input.slice(newline + 1);
    if (command.type === "control_request") {
      process.stderr.write(JSON.stringify({ control: command.request.subtype }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: command.request_id, response: {} } }) + "\\n");
      continue;
    }
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
    request("inspect"),
    piConfig,
    { system: "Inspect carefully.", tools: ["read", "grep"] },
    (event) => events.push(event),
  );
  const result = await run.completion;
  const invocation = stderrLines(result.stderr)[0] as { args: string[] };

  assert.equal(result.exitCode, 0);
  assert.equal(result.report, "pi finished");
  assert.deepEqual(invocation.args, [
    "--mode",
    "rpc",
    "--session-id",
    runId,
    "--session-dir",
    fixtureDirectory,
    "--model",
    "openai/gpt-test",
    "--thinking",
    "medium",
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

test("A delegating Pi child loads the bridge, the subagent tools, and the HTTP grant", async () => {
  const run = spawnHarness(
    request("inspect"),
    piConfig,
    {
      system: "Delegate.",
      tools: ["read"],
      delegation: delegation(),
    },
    () => undefined,
  );
  const result = await run.completion;
  const invocation = stderrLines(result.stderr)[0] as { args: string[] };
  const extensionIndex = invocation.args.indexOf("--extension");
  assert.ok(extensionIndex > 0);
  assert.match(invocation.args[extensionIndex + 1] ?? "", /bridge\.ts$/);
  assert.deepEqual(invocation.args.slice(-2), [
    "--tools",
    "read,subagent_create,subagent_message,subagent_wait,subagent_list,subagent_stop,subagent_ask",
  ]);
});

test("A resumed Claude harness passes --resume with the run id", async () => {
  const run = spawnHarness(
    request("continue", true),
    claudeConfig,
    { system: "Implement carefully." },
    () => undefined,
  );
  const result = await run.completion;
  const invocation = stderrLines(result.stderr)[0] as { args: string[] };
  assert.equal(result.report, "claude finished");
  assert.deepEqual(invocation.args.slice(0, 3), ["--print", "--resume", runId]);
  assert.equal(invocation.args.includes("--session-id"), false);
});

test("Claude emits messages, tool lifecycle, usage, and configured invocation", async () => {
  const events: HarnessEvent[] = [];
  const run = spawnHarness(
    request("inspect"),
    claudeConfig,
    {
      system: "Implement carefully.",
      tools: ["read", "ls", "find", "web_search"],
      delegation: delegation(),
    },
    (event) => events.push(event),
  );
  const result = await run.completion;
  const lines = stderrLines(result.stderr);
  const invocation = lines[0] as {
    args: string[];
    disableBackgroundTasks?: string;
    waitCeiling: string;
    noPrefix: string;
  };

  assert.equal(result.exitCode, 0);
  assert.equal(result.report, "claude finished");
  assert.equal(invocation.disableBackgroundTasks, undefined);
  assert.equal(invocation.waitCeiling, "0");
  assert.equal(invocation.noPrefix, "1");
  assert.deepEqual(invocation.args.slice(0, 9), [
    "--print",
    "--session-id",
    runId,
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
  assert.equal(invocation.args.includes("--mcp-config"), false);
  assert.ok(invocation.args.includes("--strict-mcp-config"));
  const allowedIndex = invocation.args.indexOf("--allowedTools");
  assert.deepEqual(invocation.args.slice(allowedIndex, allowedIndex + 4), [
    "--allowedTools",
    "subagent_create,subagent_message,subagent_wait,subagent_list,subagent_stop,subagent_ask",
    "--disallowedTools",
    "Task,Agent,AskUserQuestion",
  ]);
  assert.deepEqual(lines[1], { control: "initialize" });
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

test("Claude answers SDK MCP control requests over its own stdio", async () => {
  let answer: (value: string) => void = () => undefined;
  let asked = "";
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async (content) => {
  const answered = await mcp.call("subagent_ask", { prompt: "Which color?" });
  result(content + " -> " + answered.text);
});
`),
  });
  try {
    const run = spawnHarness(
      request("paint"),
      claudeConfig,
      {
        system: "Ask first.",
        delegation: delegation({
          ask: (_caller, prompt) => {
            asked = prompt;
            return new Promise<string>((resolve) => {
              answer = resolve;
            });
          },
        }),
      },
      () => undefined,
    );
    while (!asked) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 100));
    answer("teal");
    const result = await run.completion;
    const lines = stderrLines(result.stderr);
    assert.equal(result.report, "paint -> teal");
    assert.deepEqual(lines[1], {
      control: "initialize",
      sdkMcpServers: ["pi_subagents"],
      sdkMcpServerConfigs: {
        pi_subagents: { timeout: 2147483647, alwaysLoad: true },
      },
    });
    assert.deepEqual(
      lines.find((line) => "tools" in line),
      {
        tools: [
          "subagent_create",
          "subagent_message",
          "subagent_wait",
          "subagent_list",
          "subagent_stop",
          "subagent_ask",
        ],
      },
    );
    assert.deepEqual(
      lines.find((line) => "prompt" in line),
      { prompt: "paint" },
    );
  } finally {
    await executables.dispose();
  }
});

test("An unsupported Claude control request fails the run loudly", async () => {
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  write({ type: "control_request", request_id: "perm-1", request: { subtype: "can_use_tool", tool_name: "Bash" } });
});
`),
  });
  try {
    const run = spawnHarness(
      request("go"),
      claudeConfig,
      { system: "Go.", delegation: delegation() },
      () => undefined,
    );
    await assert.rejects(
      run.completion,
      /^Error: Claude sent an unsupported control request: can_use_tool$/,
    );
  } finally {
    await executables.dispose();
  }
});

test("A profile without delegates launches Claude without the SDK server and Pi without the bridge", async () => {
  const claude = spawnHarness(
    request("inspect"),
    claudeConfig,
    { system: "Inspect.", tools: ["read"] },
    () => undefined,
  );
  const claudeResult = await claude.completion;
  const claudeLines = stderrLines(claudeResult.stderr);
  const claudeInvocation = claudeLines[0] as {
    args: string[];
    noPrefix?: string;
  };
  assert.equal(claudeLines.length, 1);
  assert.equal(claudeInvocation.noPrefix, undefined);
  for (const flag of [
    "--allowedTools",
    "--disallowedTools",
    "--strict-mcp-config",
    "--mcp-config",
  ])
    assert.equal(claudeInvocation.args.includes(flag), false, flag);

  const pi = spawnHarness(
    request("inspect"),
    piConfig,
    { system: "Inspect.", tools: ["read"] },
    () => undefined,
  );
  const piResult = await pi.completion;
  const piInvocation = stderrLines(piResult.stderr)[0] as { args: string[] };
  assert.equal(piInvocation.args.includes("--extension"), false);
  assert.deepEqual(piInvocation.args.slice(-2), ["--tools", "read"]);
});

test("A harness can accept another prompt after a settled turn", async () => {
  let turns = 0;
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    request("first"),
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
    assert.equal(result.report, "second report");
    assert.equal(result.exitCode, 0);
  } finally {
    run.stop();
  }
});

test("A settled Pi harness accepts a second prompt", async () => {
  let turns = 0;
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    request("first"),
    piConfig,
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
          () => reject(new Error("Settled Pi harness did not resume")),
          500,
        ),
      ),
    ]);
    assert.equal(turns, 2);
    assert.equal(result.report, "second report");
    assert.equal(result.exitCode, 0);
  } finally {
    run.stop();
  }
});

test("Malformed harness output rejects completion", async () => {
  const run = spawnHarness(
    request("malformed"),
    piConfig,
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, SyntaxError);
});

test("An unsolicited clean exit before settlement fails loudly", async () => {
  const run = spawnHarness(
    request("exit-unsettled"),
    piConfig,
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
    request("wait"),
    piConfig,
    { system: "Wait." },
    () => undefined,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await run.send("continue");
  const result = await run.completion;
  assert.equal(result.report, "pi finished");
});

test("Stopping a harness terminates its process", async () => {
  const run = spawnHarness(
    request("wait"),
    claudeConfig,
    { system: "Wait." },
    () => undefined,
  );
  run.stop();
  const result = await run.completion;
  assert.equal(result.signal, "SIGTERM");
});

test("Claude forwards the configured permission mode", async () => {
  const run = spawnHarness(
    request("inspect"),
    { ...claudeConfig, permissionMode: "auto" },
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  const invocation = stderrLines(result.stderr)[0] as { args: string[] };
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
    request("reject"),
    piConfig,
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, /^Error: Authentication failed$/);
});

test("A Pi turn that ends with an error fails the run", async () => {
  const run = spawnHarness(
    request("pi-error"),
    piConfig,
    { system: "Inspect." },
    () => undefined,
  );
  await assert.rejects(run.completion, /^Error: 529 overloaded$/);
});

test("A failed later turn rejects with that turn's error", async () => {
  let finishFirstTurn: () => void = () => undefined;
  const firstTurn = new Promise<void>((resolve) => {
    finishFirstTurn = resolve;
  });
  const run = spawnHarness(
    request("first"),
    piConfig,
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
  await assert.rejects(run.completion, /^Error: 529 overloaded$/);
});

test("A Pi turn that recovers after a retried error completes", async () => {
  const run = spawnHarness(
    request("pi-retry"),
    piConfig,
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  assert.equal(result.report, "recovered");
  assert.equal(result.finished, true);
});

test("Pi dialog requests are answered as cancelled", async () => {
  const run = spawnHarness(
    request("dialog"),
    piConfig,
    { system: "Inspect." },
    () => undefined,
  );
  const result = await run.completion;
  assert.deepEqual(JSON.parse(result.report), {
    type: "extension_ui_response",
    id: "ui-1",
    cancelled: true,
  });
});

test("Stopping a harness kills its process group after the grace period", async () => {
  let grandchild = 0;
  const run = spawnHarness(
    request("group"),
    piConfig,
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
