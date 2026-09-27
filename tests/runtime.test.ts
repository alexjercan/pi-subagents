import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAgentRuntime } from "../extensions/pi-subagents/runtime.ts";

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("Nested delegation returns promptly and pushes the direct child's final output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const release = join(root, "release");
  const started = join(root, "started");
  const notifications = join(root, "notifications");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    tools: [read]
    system: Inspect the project.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [scout]
    system: Delegate before implementation.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const newline = input.indexOf("\\n");
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (model === "haiku") {
      const { existsSync } = await import("node:fs");
      const code = command.message.content === "Find the implementation";
      if (code) while (!existsSync(${JSON.stringify(release)})) await new Promise((resolve) => setTimeout(resolve, 5));
      process.stdout.write(JSON.stringify({ type: "result", result: code ? "scout report" : "brief report", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
      return;
    }
    if (command.message.content.includes("Subagent ") && command.message.content.includes(" finished")) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(${JSON.stringify(notifications)}, command.message.content + "\\n");
      process.stdout.write(JSON.stringify({ type: "result", result: command.message.content }) + "\\n");
      continue;
    }
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    const server = config.mcpServers.pi_subagents;
    const { Client } = await import(${JSON.stringify(clientUrl)});
    const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
    const mcpClient = new Client({ name: "fixture", version: "1.0.0" });
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
    const brief = await mcpClient.callTool({ name: "subagent", arguments: { id: "brief", name: "scout", prompt: "Find the brief" } });
    const completed = await mcpClient.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Find the implementation" } });
    const listed = await mcpClient.callTool({ name: "subagent_list", arguments: {} });
    await mcpClient.close();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(started)}, JSON.stringify({ brief: JSON.parse(brief.content[0].text), child: JSON.parse(completed.content[0].text), inventory: JSON.parse(listed.content[0].text) }));
    process.stdout.write(JSON.stringify({ type: "result", result: "Delegated scout", usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");
  }
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootMessages: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootMessage: async (message) => {
      rootMessages.push(message);
    },
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement the change",
    });
    assert.equal(worker.status, "running");
    const deadline = Date.now() + 2000;
    while (!existsSync(started) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(started), "Nested start did not return promptly");
    assert.equal(
      runtime.list().find((run) => run.runId === worker.runId)?.status,
      "running",
    );
    await writeFile(release, "");
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status ===
        "completed",
    );
    const runs = runtime.list();
    const completedWorker = runs.find((run) => run.runId === worker.runId);
    const scout = runs.find((run) => run.id === "code");
    assert.equal(scout?.parentRunId, worker.runId);
    assert.deepEqual(
      runs
        .filter((run) => run.parentRunId === worker.runId)
        .map((run) => run.id),
      ["brief", "code"],
    );
    assert.equal(scout?.result?.finalText, "scout report");
    const initial = JSON.parse(await readFile(started, "utf8")) as {
      child: { id: string; status: string };
      inventory: {
        kinds: Array<{ name: string }>;
        runs: Array<{ id: string }>;
      };
    };
    assert.deepEqual(initial.child, {
      id: "code",
      name: "scout",
      status: "running",
    });
    assert.deepEqual(
      initial.inventory.kinds.map((agent) => agent.name),
      ["scout"],
    );
    assert.ok(initial.inventory.runs.some((run) => run.id === "code"));
    const delivered = await readFile(notifications, "utf8");
    assert.equal(delivered.match(/Subagent brief finished/g)?.length, 1);
    assert.equal(delivered.match(/Subagent code finished/g)?.length, 1);
    assert.match(
      completedWorker?.result?.finalText ?? "",
      /Subagent code finished with status completed/,
    );
    assert.match(completedWorker?.result?.finalText ?? "", /scout report/);
    assert.match(rootMessages[0] ?? "", /Subagent implementation finished/);
    const inventory = await runtime.inventory();
    assert.deepEqual(
      inventory.kinds.map((agent) => agent.name),
      ["scout", "worker"],
    );
    assert.deepEqual(
      inventory.runs.map((run) => run.id),
      [],
    );
  } finally {
    await writeFile(release, "");
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("An owner that exits before its child finishes fails and cancels the child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-owner-exit-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect.
  worker:
    description: Delegate.
    harness: claude
    model: opus
    thinking: medium
    delegates: [scout]
    system: Delegate.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
process.stdin.once("data", async () => {
  if (model === "haiku") return;
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  await client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } });
  await client.close();
  process.stdout.write(JSON.stringify({ type: "result", result: "Owner exited early" }) + "\\n", () => process.exit(0));
});
`;
  await writeFile(join(bin, "claude"), fixture);
  await chmod(join(bin, "claude"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const messages: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootMessage: (message) => {
      messages.push(message);
    },
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Delegate",
    });
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status !==
        "running",
    );
    const runs = runtime.list();
    const owner = runs.find((run) => run.runId === worker.runId);
    assert.equal(owner?.status, "failed");
    assert.match(owner.error ?? "", /exited before receiving child updates/);
    await until(
      () =>
        runtime.list().find((run) => run.parentRunId === worker.runId)
          ?.status === "cancelled",
    );
    await until(() => messages.length > 0);
    assert.match(messages[0] ?? "", /status failed/);
    assert.match(messages[0] ?? "", /exited before receiving child updates/);
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi worker delegates to an allowed Claude child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-pi-delegate-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect.
  worker-sol:
    description: Implement.
    harness: pi
    model: openai-codex/gpt-5.6-sol
    thinking: high
    delegates: [scout]
    system: Delegate before implementing.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  await writeFile(
    join(bin, "claude"),
    `#!/usr/bin/env node
process.stdin.on("data", () => {
  process.stdout.write(JSON.stringify({ type: "result", result: "scout report" }) + "\\n");
});
`,
  );
  await writeFile(
    join(bin, "pi"),
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[args.indexOf("--model") + 1] !== "openai-codex/gpt-5.6-sol" ||
    args[args.indexOf("--thinking") + 1] !== "high" ||
    !args.includes("--extension") ||
    !process.env.PI_SUBAGENTS_MCP_URL || !process.env.PI_SUBAGENTS_MCP_AUTHORIZATION) {
  process.exit(1);
}
const { Client } = await import(${JSON.stringify(clientUrl)});
const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
process.stdin.on("data", async (chunk) => {
  const command = JSON.parse(chunk.toString());
  let output = command.message;
  if (!JSON.stringify(output).includes("Subagent code finished")) {
    const client = new Client({ name: "fixture", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PI_SUBAGENTS_MCP_URL), {
      requestInit: { headers: { Authorization: process.env.PI_SUBAGENTS_MCP_AUTHORIZATION } },
    }));
    const result = await client.callTool({ name: "subagent", arguments: {
      id: "code", name: "scout", prompt: "Inspect the change",
    } });
    await client.close();
    output = result.content[0].text;
  }
  process.stdout.write(JSON.stringify({ type: "message_end", message: {
    role: "assistant", content: [{ type: "text", text: JSON.stringify(output) }],
  } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
});
`,
  );
  await chmod(join(bin, "claude"), 0o755);
  await chmod(join(bin, "pi"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootMessage: async () => undefined,
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker-sol",
      prompt: "Implement the change",
    });
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status !==
        "running",
    );
    const runs = runtime.list();
    const completedWorker = runs.find((run) => run.runId === worker.runId);
    assert.equal(completedWorker?.status, "completed", completedWorker?.error);
    const child = runs.find((run) => run.parentRunId === worker.runId);
    assert.equal(child?.agent, "scout");
    assert.equal(child?.result?.finalText, "scout report");
    assert.match(completedWorker?.result?.finalText ?? "", /scout report/);
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Stopping a direct running child cancels it and wakes the root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    system: Work until stopped.
`,
  );
  const claude = join(bin, "claude");
  await writeFile(
    claude,
    `#!/usr/bin/env node
process.stdin.resume();
`,
  );
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootMessages: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootMessage: (message) => {
      rootMessages.push(message);
    },
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await assert.rejects(
      runtime.stop(undefined, "missing"),
      /^Error: Unknown directly owned subagent missing$/,
    );
    await assert.rejects(
      runtime.stop(worker.runId, "implementation"),
      /^Error: Unknown directly owned subagent implementation$/,
    );
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "cancelled",
      error: "Agent was cancelled",
    });
    await until(() => rootMessages.length > 0);
    assert.match(
      rootMessages[0] ?? "",
      /^Subagent implementation finished with status cancelled\./,
    );
    await assert.rejects(
      runtime.stop(undefined, "implementation"),
      /^Error: Subagent implementation is not running$/,
    );
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("Stopping a waiting direct child clears its question and cancels its running child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-tree-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect until stopped.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [scout]
    system: Delegate and ask.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
process.stdin.once("data", async () => {
  if (model === "haiku") return;
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  void client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } }).catch(() => undefined);
  await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } });
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootQuestion: () => undefined,
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    const scout = () =>
      runtime.list().find((run) => run.parentRunId === worker.runId);
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status ===
          "waiting" && scout()?.status === "running",
    );
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "cancelled",
      error: "Agent was cancelled",
    });
    await until(() => scout()?.status === "cancelled");
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A stop fails when the child completes, and a stopping child accepts no new work", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-race-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const ready = join(root, "ready");
  const attempts = join(root, "attempts");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [scout]
    system: Finish on stop.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const { writeFileSync } = await import("node:fs");
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  process.on("SIGTERM", async () => {
    const start = await client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } });
    const ask = await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } });
    writeFileSync(${JSON.stringify(attempts)}, JSON.stringify([start, ask]));
    process.stdout.write(JSON.stringify({ type: "result", result: "finished on stop", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n", () => process.exit(0));
  });
  writeFileSync(${JSON.stringify(ready)}, "");
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootMessages: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootQuestion: () => undefined,
    onRootMessage: (message) => {
      rootMessages.push(message);
    },
  });
  try {
    await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => existsSync(ready));
    const stopped = runtime.stop(undefined, "implementation");
    await assert.rejects(
      runtime.stop(undefined, "implementation"),
      /^Error: Subagent implementation is not running$/,
    );
    await assert.rejects(
      runtime.message(undefined, "implementation", "Continue"),
      /^Error: Subagent implementation is not running$/,
    );
    await assert.rejects(
      stopped,
      /^Error: Subagent implementation completed before it was cancelled$/,
    );
    assert.deepEqual(JSON.parse(await readFile(attempts, "utf8")), [
      {
        content: [{ type: "text", text: "Agent is not running" }],
        isError: true,
      },
      {
        content: [{ type: "text", text: "Agent is not running" }],
        isError: true,
      },
    ]);
    assert.deepEqual(
      runtime.list().map((run) => [run.id, run.status]),
      [["implementation", "completed"]],
    );
    await until(() => rootMessages.length > 0);
    assert.match(
      rootMessages[0] ?? "",
      /^Subagent implementation finished with status completed\.\nfinished on stop$/,
    );
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A stopped subtree accepts no work after the stop target is cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-stop-subtree-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const ready = join(root, "ready");
  const go = join(root, "go");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect.
  lead:
    description: Coordinate.
    harness: claude
    model: sonnet
    thinking: medium
    delegates: [scout]
    system: Coordinate.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [lead]
    system: Implement.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const { existsSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  if (model === "opus") {
    void client.callTool({ name: "subagent", arguments: { id: "coordination", name: "lead", prompt: "Coordinate" } }).catch(() => undefined);
    return;
  }
  process.on("SIGTERM", async () => {
    while (!existsSync(${JSON.stringify(go)})) await new Promise((resolve) => setTimeout(resolve, 5));
    const result = model === "sonnet"
      ? await client.callTool({ name: "subagent_message", arguments: { id: "code", message: "Continue" } })
      : await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } });
    writeFileSync(join(${JSON.stringify(root)}, model), JSON.stringify(result));
    process.exit(0);
  });
  if (model === "sonnet") {
    void client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } }).catch(() => undefined);
    return;
  }
  writeFileSync(${JSON.stringify(ready)}, "");
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
  });
  try {
    await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => existsSync(ready));
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "cancelled",
      error: "Agent was cancelled",
    });
    await writeFile(go, "");
    await until(
      () => existsSync(join(root, "sonnet")) && existsSync(join(root, "haiku")),
    );
    assert.deepEqual(JSON.parse(await readFile(join(root, "sonnet"), "utf8")), {
      content: [{ type: "text", text: "Subagent code is not running" }],
      isError: true,
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, "haiku"), "utf8")), {
      content: [{ type: "text", text: "Agent is not running" }],
      isError: true,
    });
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A top-level question notifies the owner and waits for its message", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-ask-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    system: Ask when blocked.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  const response = await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } });
  await client.close();
  process.stdout.write(JSON.stringify({ type: "result", result: response.content[0].text, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootQuestions: Array<{ id: string; prompt: string }> = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootQuestion: (id, prompt) => {
      rootQuestions.push({ id, prompt });
    },
  });
  try {
    await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await assert.rejects(
      runtime.start({
        id: "implementation",
        name: "worker",
        prompt: "Duplicate",
      }),
      /Duplicate directly owned subagent id/,
    );
    await until(() => runtime.list()[0]?.status === "waiting");
    const waiting = await runtime.inventory();
    assert.deepEqual(waiting.runs, [
      {
        id: "implementation",
        name: "worker",
        status: "waiting",
        question: "Which API?",
      },
    ]);
    assert.deepEqual(rootQuestions, [
      { id: "implementation", prompt: "Which API?" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(runtime.list()[0]?.status, "waiting");
    await runtime.message(undefined, "implementation", "Use the stable API");
    await until(() => runtime.list()[0]?.status === "completed");
    assert.equal(runtime.list()[0]?.result?.finalText, "Use the stable API");
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A nested question wakes the direct parent and resumes on its answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-nested-ask-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const response = join(root, "response");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Ask when blocked.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [scout]
    system: Answer your children.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
const server = config.mcpServers.pi_subagents;
const { Client } = await import(${JSON.stringify(clientUrl)});
const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
const client = new Client({ name: "fixture", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
process.stdin.on("data", async (chunk) => {
  const command = JSON.parse(chunk.toString());
  const content = command.message.content;
  if (model === "opus" && content.includes("Subagent code finished")) {
    await client.close();
    process.stdout.write(JSON.stringify({ type: "result", result: content }) + "\\n");
    return;
  }
  if (model === "haiku") {
    const answer = await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which file?" } });
    await client.close();
    process.stdout.write(JSON.stringify({ type: "result", result: "scout read " + answer.content[0].text, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
    return;
  }
  if (content.includes("Subagent code is waiting")) {
    const resumed = await client.callTool({ name: "subagent_message", arguments: { id: "code", message: "runtime.ts" } });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(response)}, resumed.content[0].text);
    process.stdout.write(JSON.stringify({ type: "result", result: "Answered scout" }) + "\\n");
    return;
  }
  const asked = await client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } });
  process.stdout.write(JSON.stringify({ type: "result", result: asked.content[0].text, usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootQuestions: Array<{ id: string; prompt: string }> = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootQuestion: (id, prompt) => {
      rootQuestions.push({ id, prompt });
    },
  });
  try {
    const worker = await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    const deadline = Date.now() + 3000;
    while (
      runtime.list().find((run) => run.runId === worker.runId)?.status ===
        "running" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const finishedWorker = runtime
      .list()
      .find((run) => run.runId === worker.runId);
    assert.equal(
      finishedWorker?.status,
      "completed",
      finishedWorker?.error ?? "Nested question stalled",
    );
    const resumed = JSON.parse(await readFile(response, "utf8"));
    assert.deepEqual(resumed, {
      id: "code",
      name: "scout",
      status: "running",
    });
    assert.match(
      runtime.list().find((run) => run.runId === worker.runId)?.result
        ?.finalText ?? "",
      /scout read runtime.ts/,
    );
    assert.deepEqual(rootQuestions, []);
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A question pending when its subagent exits rejects a late answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-abandon-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  const abandon = join(root, "abandon");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    system: Ask when blocked.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const { existsSync } = await import("node:fs");
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } }).catch(() => {});
  while (!existsSync(${JSON.stringify(abandon)})) await new Promise((resolve) => setTimeout(resolve, 5));
  process.stdout.write(JSON.stringify({ type: "result", result: "abandoned the question", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n", () => process.exit(0));
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const rootQuestions: Array<{ id: string; prompt: string }> = [];
  const rootMessages: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onRootQuestion: async (id, prompt) => {
      rootQuestions.push({ id, prompt });
      await writeFile(abandon, "");
    },
    onRootMessage: (message) => {
      rootMessages.push(message);
    },
  });
  try {
    await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => runtime.list()[0]?.status === "completed");
    assert.deepEqual(rootQuestions, [
      { id: "implementation", prompt: "Which API?" },
    ]);
    assert.equal(
      runtime.list()[0]?.result?.finalText,
      "abandoned the question",
    );
    assert.match(
      rootMessages[0] ?? "",
      /Subagent implementation finished with status completed/,
    );
    await assert.rejects(
      runtime.message(undefined, "implementation", "Use the stable API"),
      /Subagent implementation is not running/,
    );
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A failing root question handler rejects the pending question", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-handler-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(agentDir, "subagents.yaml"),
    `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    system: Ask when blocked.
`,
  );
  const clientUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
    ),
  ).href;
  const transportUrl = pathToFileURL(
    join(
      process.cwd(),
      "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
    ),
  ).href;
  const fixture = `#!/usr/bin/env node
const args = process.argv.slice(2);
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  const response = await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which API?" } });
  await client.close();
  process.stdout.write(JSON.stringify({ type: "result", result: response.content[0].text, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
});
`;
  const claude = join(bin, "claude");
  await writeFile(claude, fixture);
  await chmod(claude, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  const statuses: string[] = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    onUpdate: (runs) => {
      const status = runs[0]?.status;
      if (status && statuses.at(-1) !== status) statuses.push(status);
    },
    onRootQuestion: () => {
      throw new Error("Owner could not be notified");
    },
  });
  try {
    await runtime.start({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => runtime.list()[0]?.status === "completed");
    assert.equal(
      runtime.list()[0]?.result?.finalText,
      "Owner could not be notified",
    );
    assert.equal(runtime.list()[0]?.question, undefined);
    assert.match(statuses.join(","), /waiting,running/);
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
