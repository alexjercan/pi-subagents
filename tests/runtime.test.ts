import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAgentRuntime } from "../extensions/pi-subagents/runtime.ts";

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("Async child completion wakes its direct owner with final output", async () => {
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
let started = false;
let mcpClient;
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const newline = input.indexOf("\\n");
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    const message = command.message?.content ?? command.message;
    if (model === "haiku") {
      process.stdout.write(JSON.stringify({ type: "result", result: "scout report", usage: { input_tokens: 1, output_tokens: 1 } }) + "\\n");
      return;
    }
    if (!started) {
      started = true;
      const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
      const server = config.mcpServers.pi_subagents;
      const { Client } = await import(${JSON.stringify(clientUrl)});
      const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
      mcpClient = new Client({ name: "fixture", version: "1.0.0" });
      await mcpClient.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
      await mcpClient.callTool({ name: "subagent", arguments: { id: "code", name: "scout", prompt: "Find the implementation" } });
      continue;
    }
    const listed = await mcpClient.callTool({ name: "subagent_list", arguments: {} });
    await mcpClient.close();
    process.stdout.write(JSON.stringify({ type: "result", result: JSON.stringify({ wake: message, inventory: JSON.parse(listed.content[0].text) }), usage: { input_tokens: 2, output_tokens: 2 } }) + "\\n");
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
      wake: string;
      inventory: {
        kinds: Array<{ name: string }>;
        runs: Array<{ id: string }>;
      };
    };
    assert.match(
      workerResult.wake,
      /Subagent code finished with status completed\.\nscout report/,
    );
    assert.deepEqual(
      workerResult.inventory.kinds.map((agent) => agent.name),
      ["scout"],
    );
    assert.deepEqual(
      workerResult.inventory.runs.map((run) => run.id),
      ["code"],
    );
    assert.match(rootMessages[0] ?? "", /Subagent implementation finished/);
    const inventory = await runtime.inventory();
    assert.deepEqual(
      inventory.kinds.map((agent) => agent.name),
      ["scout", "worker"],
    );
    assert.deepEqual(
      inventory.runs.map((run) => run.id),
      ["implementation"],
    );
    assert.equal(
      inventory.runs[0]?.finalText,
      completedWorker?.result?.finalText,
    );
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("A subagent question waits for its direct owner's message", async () => {
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
    assert.match(rootMessages[0] ?? "", /Which API\?/);
    await runtime.message(undefined, "implementation", "Use the stable API");
    await until(() => runtime.list()[0]?.status === "completed");
    assert.equal(runtime.list()[0]?.result?.finalText, "Use the stable API");
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
