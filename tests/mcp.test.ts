import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDelegationHost } from "../extensions/pi-subagents/mcp.ts";
import type { DelegationOperations } from "../extensions/pi-subagents/tools.ts";

const toolNames = [
  "subagent_ask",
  "subagent_create",
  "subagent_list",
  "subagent_message",
  "subagent_stop",
  "subagent_wait",
];

async function client(url: string, authorization: string) {
  const value = new Client({ name: "test-client", version: "1.0.0" });
  await value.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorization } },
    }),
  );
  return value;
}

function operations(
  overrides: Partial<DelegationOperations> = {},
): DelegationOperations {
  return {
    create: async () => ({ status: "running" }),
    message: async () => ({ status: "running" }),
    wait: async () => ["notice"],
    stop: async () => ({ status: "stopped" }),
    list: async () => ({ kinds: [], runs: [] }),
    ask: async () => "answer",
    ...overrides,
  };
}

function content(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (
    (result.content as Array<{ type: string; text: string }>)[0]?.text ?? ""
  );
}

test("MCP exposes the six subagent tools with direct-owner identity", async () => {
  const creates: unknown[] = [];
  const messages: unknown[] = [];
  const stops: unknown[] = [];
  const waits: unknown[] = [];
  const host = await createDelegationHost(
    operations({
      create: async (...args) => {
        creates.push(args);
        return { id: args[1], status: "running" };
      },
      message: async (...args) => {
        messages.push(args);
        return { status: "running" };
      },
      wait: async (callerRunId, ids) => {
        waits.push([callerRunId, ids]);
        return ["Subagent code is idle.\nreport"];
      },
      stop: async (...args) => {
        stops.push(args);
        return { id: args[1], status: "stopped" };
      },
      list: async (callerRunId) => ({
        kinds: [{ name: "scout" }],
        runs: [{ id: "code", owner: callerRunId }],
      }),
    }),
  );
  const grant = host.grant("worker-run", ["scout"]);
  const connected = await client(host.url, grant.http().authorization);
  try {
    const listedTools = await connected.listTools();
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name).sort(),
      toolNames,
    );
    const created = await connected.callTool({
      name: "subagent_create",
      arguments: { id: "code", name: "scout", prompt: "Inspect" },
    });
    assert.equal(created.isError, undefined);
    assert.deepEqual(creates, [["worker-run", "code", "scout", "Inspect"]]);
    await connected.callTool({
      name: "subagent_message",
      arguments: { id: "code", message: "Focus on config" },
    });
    assert.deepEqual(messages, [["worker-run", "code", "Focus on config"]]);
    const waited = await connected.callTool({
      name: "subagent_wait",
      arguments: { ids: ["code"] },
    });
    assert.deepEqual(waits, [["worker-run", ["code"]]]);
    assert.equal(content(waited), "Subagent code is idle.\nreport");
    const stopped = await connected.callTool({
      name: "subagent_stop",
      arguments: { id: "code" },
    });
    assert.deepEqual(stops, [["worker-run", "code"]]);
    assert.deepEqual(JSON.parse(content(stopped)), {
      id: "code",
      status: "stopped",
    });
    const listed = await connected.callTool({
      name: "subagent_list",
      arguments: {},
    });
    assert.deepEqual(JSON.parse(content(listed)), {
      kinds: [{ name: "scout" }],
      runs: [{ id: "code", owner: "worker-run" }],
    });
  } finally {
    await connected.close();
    await host.close();
  }
});

test("A grant serves an in-memory server without an HTTP registration", async () => {
  const asks: string[] = [];
  const host = await createDelegationHost(
    operations({
      ask: async (callerRunId) => {
        asks.push(callerRunId);
        return "teal";
      },
    }),
  );
  const grant = host.grant("claude-run", []);
  const [clientEnd, serverEnd] = InMemoryTransport.createLinkedPair();
  const connected = new Client({ name: "in-memory", version: "1.0.0" });
  try {
    await grant.server().connect(serverEnd);
    await connected.connect(clientEnd);
    const listedTools = await connected.listTools();
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name).sort(),
      toolNames,
    );
    const asked = await connected.callTool({
      name: "subagent_ask",
      arguments: { prompt: "Which color?" },
    });
    assert.equal(content(asked), "teal");
    assert.deepEqual(asks, ["claude-run"]);
    const response = await fetch(host.url, {
      method: "POST",
      headers: {
        Authorization: "Bearer anything",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 401);
    await response.text();
  } finally {
    await connected.close();
    await host.close();
  }
});

test("Revoking a grant closes its HTTP registration", async () => {
  const host = await createDelegationHost(operations());
  const grant = host.grant("worker-run", []);
  const { authorization } = grant.http();
  const connected = await client(host.url, authorization);
  try {
    await connected.listTools();
    grant.revoke();
    await assert.rejects(client(host.url, authorization), /401|Unauthorized/);
  } finally {
    await connected.close().catch(() => undefined);
    await host.close();
  }
});

test("MCP ask uses the authenticated caller and propagates cancellation", async () => {
  let caller = "";
  let delegatedSignal: AbortSignal | undefined;
  const host = await createDelegationHost(
    operations({
      ask: async (callerRunId, _prompt, signal) => {
        caller = callerRunId;
        delegatedSignal = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    }),
  );
  const connected = await client(
    host.url,
    host.grant("worker-run", []).http().authorization,
  );
  const controller = new AbortController();
  try {
    const call = connected.callTool(
      { name: "subagent_ask", arguments: { prompt: "Which API?" } },
      undefined,
      { signal: controller.signal },
    );
    while (!delegatedSignal)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(caller, "worker-run");
    controller.abort();
    await assert.rejects(call);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(delegatedSignal.aborted, true);
  } finally {
    await connected.close();
    await host.close();
  }
});

test("MCP rejects a subagent kind outside the grant", async () => {
  let called = false;
  const host = await createDelegationHost(
    operations({
      create: async () => {
        called = true;
        return {};
      },
    }),
  );
  const connected = await client(
    host.url,
    host.grant("worker-run", ["scout"]).http().authorization,
  );
  try {
    const result = await connected.callTool({
      name: "subagent_create",
      arguments: { id: "review", name: "review", prompt: "Review" },
    });
    assert.equal(result.isError, true);
    assert.match(content(result), /not an allowed delegate/);
    assert.equal(called, false);
  } finally {
    await connected.close();
    await host.close();
  }
});

test("MCP ask streams response headers before the answer arrives", async () => {
  let answer: (value: string) => void = () => undefined;
  const host = await createDelegationHost(
    operations({
      ask: () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    }),
  );
  const { authorization } = host.grant("worker-run", []).http();
  const post = (body: unknown, sessionId?: string) =>
    fetch(host.url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(body),
    });
  try {
    const initialized = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "raw", version: "1" },
      },
    });
    const sessionId = initialized.headers.get("mcp-session-id") ?? "";
    await initialized.text();
    await (
      await post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      )
    ).text();
    const asked = await post(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "subagent_ask", arguments: { prompt: "Which API?" } },
      },
      sessionId,
    );
    assert.equal(asked.headers.get("content-type"), "text/event-stream");
    answer("stable");
    assert.match(await asked.text(), /stable/);
  } finally {
    await host.close();
  }
});

test("MCP wait reports progress every 30 seconds while it waits", async (t) => {
  let answer: (value: string[]) => void = () => undefined;
  let waiting = false;
  const host = await createDelegationHost(
    operations({
      wait: () =>
        new Promise<string[]>((resolve) => {
          waiting = true;
          answer = resolve;
        }),
    }),
  );
  const connected = await client(
    host.url,
    host.grant("worker-run", []).http().authorization,
  );
  t.after(async () => {
    await connected.close();
    await host.close();
  });
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  const progress: number[] = [];
  const call = connected.callTool(
    { name: "subagent_wait", arguments: {} },
    undefined,
    {
      onprogress: (value) => progress.push(value.progress),
      resetTimeoutOnProgress: true,
    },
  );
  while (!waiting) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(29999);
  mock.timers.tick(1);
  mock.timers.tick(30000);
  while (progress.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(progress, [1, 2]);
  answer(["Subagent code is idle.\nreport"]);
  assert.equal(content(await call), "Subagent code is idle.\nreport");
});
