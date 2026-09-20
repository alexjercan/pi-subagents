import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Type } from "typebox";

interface McpContent {
  type: string;
  text?: string;
}

export default function piSubagentBridge(pi: ExtensionAPI): void {
  let client: Client | undefined;

  pi.on("session_start", async () => {
    const url = process.env.PI_SUBAGENTS_MCP_URL;
    const authorization = process.env.PI_SUBAGENTS_MCP_AUTHORIZATION;
    if (!url || !authorization)
      throw new Error("Subagent MCP connection is not configured");
    client = new Client({ name: "pi-subagent-bridge", version: "0.1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: authorization } },
      }),
    );
  });

  pi.on("session_shutdown", async () => {
    const connected = client;
    client = undefined;
    await connected?.close();
  });

  const invoke = async (
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => {
    if (!client) throw new Error("Subagent MCP connection is not running");
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      signal ? { signal } : undefined,
    );
    const content = result.content as McpContent[];
    return {
      content: content.map((item) => ({
        type: "text" as const,
        text: item.text ?? JSON.stringify(item),
      })),
      details: {},
      ...(result.isError ? { isError: true } : {}),
    };
  };

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Start a configured direct child and return immediately.",
    parameters: Type.Object({
      id: Type.String({ description: "Owner-scoped child identifier" }),
      name: Type.String({ description: "Configured agent kind" }),
      prompt: Type.String({ description: "Initial prompt" }),
    }),
    execute: (_id, params, signal) => invoke("subagent", params, signal),
  });

  pi.registerTool({
    name: "subagent_message",
    label: "Subagent Message",
    description: "Send a message to a directly owned running child.",
    parameters: Type.Object({
      id: Type.String({ description: "Direct child identifier" }),
      message: Type.String({ description: "Message or question response" }),
    }),
    execute: (_id, params, signal) =>
      invoke("subagent_message", params, signal),
  });

  pi.registerTool({
    name: "subagent_list",
    label: "Subagent List",
    description: "List allowed agent kinds and directly owned runs.",
    parameters: Type.Object({}),
    execute: (_id, _params, signal) => invoke("subagent_list", {}, signal),
  });

  pi.registerTool({
    name: "subagent_ask",
    label: "Subagent Ask",
    description: "Ask the direct owner a question and wait for its answer.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Question for the direct owner" }),
    }),
    execute: (_id, params, signal) => invoke("subagent_ask", params, signal),
  });
}
