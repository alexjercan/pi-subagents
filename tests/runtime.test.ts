import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createAgentRuntime } from "../extensions/pi-subagents/runtime.ts";

test("A Claude worker delegates a scout through the owning runtime", async () => {
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
    tools: [read, grep, find, ls]
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
let result = model + " finished";
if (model === "opus") {
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
  const server = config.mcpServers.pi_subagents;
  const { Client } = await import(${JSON.stringify(clientUrl)});
  const { StreamableHTTPClientTransport } = await import(${JSON.stringify(transportUrl)});
  const client = new Client({ name: "fixture", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } }));
  const response = await client.callTool({ name: "spawn", arguments: { agent: "scout", task: "Find the implementation" } });
  result = "worker received " + response.content[0].text;
  await client.close();
}
process.stdout.write(JSON.stringify({ type: "result", result, usage: { output_tokens: 1 } }) + "\\n");
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
    const result = await runtime.run(
      "worker",
      "Implement the change",
      undefined,
      new AbortController().signal,
    );
    assert.equal(result.result?.finalText, "worker received haiku finished");
    const runs = runtime.list();
    assert.equal(runs.length, 2);
    const worker = runs.find((run) => run.agent === "worker");
    const scout = runs.find((run) => run.agent === "scout");
    assert.equal(worker?.status, "completed");
    assert.equal(scout?.status, "completed");
    assert.equal(scout?.parentId, worker?.id);
  } finally {
    await runtime.close();
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
