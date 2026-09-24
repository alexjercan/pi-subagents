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

test("Nested delegation waits for the direct child's final output", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-runtime-"));
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
    JSON.parse(line);
    if (model === "haiku") {
      process.stdout.write(JSON.stringify({ type: "result", result: "scout report", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
      return;
    }
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    const server = config.mcpServers.pi_subagents;
    const { Client } = await import(${JSON.stringify(clientUrl)});
    const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
    const mcpClient = new Client({ name: "fixture", version: "1.0.0" });
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
    const completed = await mcpClient.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Find the implementation" } });
    const listed = await mcpClient.callTool({ name: "subagent_list", arguments: {} });
    await mcpClient.close();
    process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ child: JSON.parse(completed.content[0].text), inventory: JSON.parse(listed.content[0].text) }), usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");
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
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status ===
        "completed",
    );
    const runs = runtime.list();
    const completedWorker = runs.find((run) => run.runId === worker.runId);
    const scout = runs.find((run) => run.agent === "scout");
    assert.equal(scout?.id, "code");
    assert.equal(scout?.parentRunId, worker.runId);
    assert.equal(scout?.result?.finalText, "scout report");
    const workerResult = JSON.parse(
      completedWorker?.result?.finalText ?? "{}",
    ) as {
      child: { id: string; status: string; finalText: string };
      inventory: {
        kinds: Array<{ name: string }>;
        runs: Array<{ id: string }>;
      };
    };
    assert.deepEqual(workerResult.child, {
      id: "code",
      name: "scout",
      status: "completed",
      finalText: "scout report",
    });
    assert.deepEqual(
      workerResult.inventory.kinds.map((agent) => agent.name),
      ["scout"],
    );
    assert.deepEqual(
      workerResult.inventory.runs.map((run) => run.id),
      [],
    );
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
process.stdin.once("data", async () => {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  if (model === "haiku") {
    const answer = await client.callTool({ name: "subagent_ask", arguments: { prompt: "Which file?" } });
    await client.close();
    process.stdout.write(JSON.stringify({ type: "result", result: "scout read " + answer.content[0].text, usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
    return;
  }
  const asked = await client.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Inspect" } });
  const resumed = await client.callTool({ name: "subagent_message", arguments: { id: "code", message: "runtime.ts" } });
  await client.close();
  process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ asked: JSON.parse(asked.content[0].text), resumed: JSON.parse(resumed.content[0].text) }), usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");
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
    await until(
      () =>
        runtime.list().find((run) => run.runId === worker.runId)?.status ===
        "completed",
    );
    const workerResult = JSON.parse(
      runtime.list().find((run) => run.runId === worker.runId)?.result
        ?.finalText ?? "{}",
    ) as { asked: unknown; resumed: unknown };
    assert.deepEqual(workerResult.asked, {
      id: "code",
      name: "scout",
      status: "waiting",
      question: "Which file?",
    });
    assert.deepEqual(workerResult.resumed, {
      id: "code",
      name: "scout",
      status: "completed",
      finalText: "scout read runtime.ts",
    });
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
