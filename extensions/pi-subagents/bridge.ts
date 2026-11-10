import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerPiTools } from "./pi-tools.ts";
import { SUBAGENT_TOOLS } from "./tools.ts";

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
    client = new Client({ name: "pi-subagent-bridge", version: "0.2.0" });
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

  registerPiTools(pi, SUBAGENT_TOOLS, async (name, args, signal) => {
    if (!client) throw new Error("Subagent MCP connection is not running");
    const result = await client.callTool({ name, arguments: args }, undefined, {
      signal,
      onprogress: () => undefined,
      resetTimeoutOnProgress: true,
    });
    const content = result.content as McpContent[];
    return {
      content: content.map((item) => ({
        type: "text" as const,
        text: item.text ?? JSON.stringify(item),
      })),
      details: {},
      ...(result.isError ? { isError: true } : {}),
    };
  });
}
