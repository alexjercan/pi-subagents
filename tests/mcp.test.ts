import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createDelegationHost } from "../extensions/pi-subagents/mcp.ts";

async function client(url: string, authorization: string) {
  const value = new Client({ name: "test-client", version: "1.0.0" });
  await value.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: authorization } },
    }),
  );
  return value;
}

test("MCP delegates concurrent allowed agents with the parent identity", async () => {
  const calls: Array<{ parentId: string; agent: string; task: string }> = [];
  const host = await createDelegationHost(async (parentId, agent, task) => {
    calls.push({ parentId, agent, task });
    return "scout report";
  });
  const authorization = host.grant("worker-run", [
    "scout",
    "research",
    "review",
  ]);
  const connected = await client(host.url, authorization);
  try {
    const requests = [
      { agent: "scout", task: "Inspect configuration" },
      { agent: "scout", task: "Inspect tests" },
      { agent: "research", task: "Research the external API" },
      { agent: "review", task: "Review the implementation" },
    ];
    const results = await Promise.all(
      requests.map((request) =>
        connected.callTool({ name: "spawn", arguments: request }),
      ),
    );
    for (const result of results) {
      assert.deepEqual(result.content, [
        { type: "text", text: "scout report" },
      ]);
    }
    assert.deepEqual(
      calls,
      requests.map((request) => ({ parentId: "worker-run", ...request })),
    );
  } finally {
    await connected.close();
    await host.close();
  }
});

test("Cancelling an MCP request cancels the delegated run", async () => {
  let delegatedSignal: AbortSignal | undefined;
  let resolveCancelled: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const host = await createDelegationHost(
    async (_parentId, _agent, _task, signal) => {
      delegatedSignal = signal;
      return await new Promise<string>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            resolveCancelled();
            reject(new Error("cancelled"));
          },
          { once: true },
        );
      });
    },
  );
  const connected = await client(host.url, host.grant("worker-run", ["scout"]));
  const controller = new AbortController();
  try {
    const call = connected.callTool(
      {
        name: "spawn",
        arguments: { agent: "scout", task: "Wait" },
      },
      undefined,
      { signal: controller.signal },
    );
    while (!delegatedSignal)
      await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(call);
    await cancelled;
    assert.equal(delegatedSignal.aborted, true);
  } finally {
    await connected.close();
    await host.close();
  }
});

test("MCP rejects a delegate outside the grant", async () => {
  const host = await createDelegationHost(async () => "unexpected");
  const connected = await client(host.url, host.grant("worker-run", ["scout"]));
  try {
    const result = await connected.callTool({
      name: "spawn",
      arguments: { agent: "review", task: "Review" },
    });
    assert.equal(result.isError, true);
    const content = result.content as Array<{ type: string; text: string }>;
    assert.match(content[0]?.text ?? "", /not an allowed delegate/);
  } finally {
    await connected.close();
    await host.close();
  }
});
