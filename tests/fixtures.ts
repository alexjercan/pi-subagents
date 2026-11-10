import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const sdkClientUrl = pathToFileURL(
  join(
    process.cwd(),
    "node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js",
  ),
).href;

export const sdkTransportUrl = pathToFileURL(
  join(
    process.cwd(),
    "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js",
  ),
).href;

export function claudeFixture(body: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const log = (entry) => process.stderr.write(JSON.stringify(entry) + "\\n");
log({ args, env: {
  waitCeiling: process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
  noPrefix: process.env.CLAUDE_AGENT_SDK_MCP_NO_PREFIX,
  disableBackground: process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
} });
const write = (frame) => new Promise((resolve) => process.stdout.write(JSON.stringify(frame) + "\\n", resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingControl = new Map();
let nextId = 0;
const control = (request) => new Promise((resolve) => {
  const requestId = "req-" + nextId++;
  pendingControl.set(requestId, resolve);
  write({ type: "control_request", request_id: requestId, request });
});
const mcpRequest = async (method, params) => {
  const id = nextId++;
  const response = await control({ subtype: "mcp_message", server_name: "pi_subagents", message: { jsonrpc: "2.0", id, method, params } });
  return response.mcp_response;
};
const mcpNotify = (method, params) => control({ subtype: "mcp_message", server_name: "pi_subagents", message: { jsonrpc: "2.0", method, params } });
let connected;
const mcp = {
  async call(name, callArguments) {
    if (!connected) throw new Error("fixture has no MCP server");
    await connected;
    const response = await mcpRequest("tools/call", { name, arguments: callArguments, _meta: { progressToken: nextId } });
    const result = response.result;
    return { text: result.content[0].text, isError: result.isError === true };
  },
};
const result = (text) => write({ type: "result", subtype: "success", is_error: false, result: text, usage: { input_tokens: 1, output_tokens: 1 } });
let promptHandler = async () => undefined;
const onPrompt = (handler) => { promptHandler = handler; };
let queue = Promise.resolve();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const line = input.slice(0, input.indexOf("\\n"));
    input = input.slice(line.length + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
function handle(frame) {
  if (frame.type === "control_request") {
    log({ control: frame.request.subtype, sdkMcpServers: frame.request.sdkMcpServers, sdkMcpServerConfigs: frame.request.sdkMcpServerConfigs });
    if (frame.request.subtype !== "initialize") return;
    write({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: {} } });
    connected = (async () => {
      await mcpRequest("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "1" } });
      await mcpNotify("notifications/initialized");
      const listed = await mcpRequest("tools/list");
      log({ tools: listed.result.tools.map((tool) => tool.name) });
    })();
    return;
  }
  if (frame.type === "control_response") {
    const resolve = pendingControl.get(frame.response.request_id);
    pendingControl.delete(frame.response.request_id);
    resolve?.(frame.response.response);
    return;
  }
  if (frame.type === "user") {
    log({ prompt: frame.message.content });
    queue = queue.then(() => promptHandler(frame.message.content));
  }
}
${body}
`;
}

export function piFixture(body: string): string {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const model = args[args.indexOf("--model") + 1];
const log = (entry) => process.stderr.write(JSON.stringify(entry) + "\\n");
log({ args, env: { url: process.env.PI_SUBAGENTS_MCP_URL, authorization: process.env.PI_SUBAGENTS_MCP_AUTHORIZATION } });
const write = (frame) => new Promise((resolve) => process.stdout.write(JSON.stringify(frame) + "\\n", resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let client;
const mcp = {
  async call(name, callArguments) {
    if (!client) {
      const { Client } = await import(${JSON.stringify(sdkClientUrl)});
      const { StreamableHTTPClientTransport } = await import(${JSON.stringify(sdkTransportUrl)});
      client = new Client({ name: "fixture", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(process.env.PI_SUBAGENTS_MCP_URL), {
        requestInit: { headers: { Authorization: process.env.PI_SUBAGENTS_MCP_AUTHORIZATION } },
      }));
    }
    const response = await client.callTool({ name, arguments: callArguments });
    return { text: response.content[0].text, isError: response.isError === true };
  },
};
const result = async (text) => {
  await write({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
  await write({ type: "agent_settled" });
};
let promptHandler = async () => undefined;
const onPrompt = (handler) => { promptHandler = handler; };
let queue = Promise.resolve();
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (input.includes("\\n")) {
    const line = input.slice(0, input.indexOf("\\n"));
    input = input.slice(line.length + 1);
    if (!line) continue;
    const frame = JSON.parse(line);
    if (frame.type !== "prompt") continue;
    log({ prompt: frame.message });
    queue = queue.then(() => promptHandler(frame.message));
  }
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
${body}
`;
}

export interface FixtureBin {
  bin: string;
  dispose(): Promise<void>;
}

export async function installExecutables(
  executables: Record<string, string>,
): Promise<FixtureBin> {
  const bin = await mkdtemp(join(tmpdir(), "pi-subagents-bin-"));
  await mkdir(bin, { recursive: true });
  for (const [name, source] of Object.entries(executables)) {
    await writeFile(join(bin, name), source);
    await chmod(join(bin, name), 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  return {
    bin,
    async dispose() {
      process.env.PATH = previousPath;
      await rm(bin, { recursive: true, force: true });
    },
  };
}

export function stderrLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
