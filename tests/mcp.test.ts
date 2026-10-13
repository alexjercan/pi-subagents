import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  createDelegationHost,
  type DelegationOperations,
} from "../extensions/pi-subagents/mcp.ts";

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
    start: async () => ({ status: "running" }),
    message: async () => ({ status: "running" }),
    stop: async () => ({ status: "cancelled" }),
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

test("MCP exposes the five subagent tools with direct-owner identity", async () => {
  const starts: unknown[] = [];
  const messages: unknown[] = [];
  const stops: unknown[] = [];
  const host = await createDelegationHost(
    operations({
      start: async (...args) => {
        starts.push(args);
        return { id: args[1], status: "running" };
      },
      message: async (...args) => {
        messages.push(args);
        return { status: "running" };
      },
      stop: async (...args) => {
        stops.push(args);
        return { id: args[1], status: "cancelled" };
      },
      list: async (callerRunId) => ({
        kinds: [{ name: "scout" }],
        runs: [{ id: "code", owner: callerRunId }],
      }),
    }),
  );
  const connected = await client(host.url, host.grant("worker-run", ["scout"]));
  try {
    const listedTools = await connected.listTools();
    assert.deepEqual(listedTools.tools.map((tool) => tool.name).sort(), [
      "subagent",
      "subagent_ask",
      "subagent_list",
      "subagent_message",
      "subagent_stop",
    ]);
    const started = await connected.callTool({
      name: "subagent",
      arguments: { id: "code", name: "scout", prompt: "Inspect" },
    });
    assert.equal(started.isError, undefined);
    assert.deepEqual(starts, [["worker-run", "code", "scout", "Inspect"]]);
    await connected.callTool({
      name: "subagent_message",
      arguments: { id: "code", message: "Focus on config" },
    });
    assert.deepEqual(messages, [["worker-run", "code", "Focus on config"]]);
    const stopped = await connected.callTool({
      name: "subagent_stop",
      arguments: { id: "code" },
    });
    assert.deepEqual(stops, [["worker-run", "code"]]);
    assert.deepEqual(JSON.parse(content(stopped)), {
      id: "code",
      status: "cancelled",
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
  const connected = await client(host.url, host.grant("worker-run", []));
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
      start: async () => {
        called = true;
        return {};
      },
    }),
  );
  const connected = await client(host.url, host.grant("worker-run", ["scout"]));
  try {
    const result = await connected.callTool({
      name: "subagent",
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
  const authorization = host.grant("worker-run", []);
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

test("MCP ask reports progress every 30 seconds while it waits", async (t) => {
  let answer: (value: string) => void = () => undefined;
  let asked = false;
  const host = await createDelegationHost(
    operations({
      ask: () =>
        new Promise<string>((resolve) => {
          asked = true;
          answer = resolve;
        }),
    }),
  );
  const connected = await client(host.url, host.grant("worker-run", []));
  t.after(async () => {
    await connected.close();
    await host.close();
  });
  mock.timers.enable({ apis: ["setInterval"] });
  t.after(() => mock.timers.reset());
  const progress: number[] = [];
  const call = connected.callTool(
    { name: "subagent_ask", arguments: { prompt: "Which API?" } },
    undefined,
    {
      onprogress: (value) => progress.push(value.progress),
      resetTimeoutOnProgress: true,
    },
  );
  while (!asked) await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(29999);
  mock.timers.tick(1);
  mock.timers.tick(30000);
  while (progress.length < 2)
    await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(progress, [1, 2]);
  answer("stable");
  assert.equal(content(await call), "stable");
});
