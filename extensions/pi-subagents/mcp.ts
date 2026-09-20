import { randomBytes, randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import * as z from "zod/v4";

interface Grant {
  parentId: string;
  agents: Set<string>;
}

interface Connection {
  authorization: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface DelegationHost {
  url: string;
  grant(parentId: string, agents: string[]): string;
  revoke(authorization: string): void;
  close(): Promise<void>;
}

export async function createDelegationHost(
  spawn: (
    parentId: string,
    agent: string,
    task: string,
    signal: AbortSignal,
  ) => Promise<string>,
): Promise<DelegationHost> {
  const grants = new Map<string, Grant>();
  const connections = new Map<string, Connection>();
  const app = createMcpExpressApp({ host: "127.0.0.1" });

  const createServer = (grant: Grant) => {
    const server = new McpServer({ name: "pi-subagents", version: "0.1.0" });
    server.registerTool(
      "spawn",
      {
        description:
          "Spawn an allowed named subagent and return its final report.",
        inputSchema: {
          agent: z.string().min(1),
          task: z.string().min(1),
        },
      },
      async ({ agent, task }, extra) => {
        if (!grant.agents.has(agent)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Agent ${agent} is not an allowed delegate`,
              },
            ],
            isError: true,
          };
        }
        try {
          const result = await spawn(grant.parentId, agent, task, extra.signal);
          return { content: [{ type: "text" as const, text: result }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text" as const,
                text: error instanceof Error ? error.message : String(error),
              },
            ],
            isError: true,
          };
        }
      },
    );
    return server;
  };

  const handle = async (request: Request, response: Response) => {
    const authorization = request.header("authorization") ?? "";
    const grant = grants.get(authorization);
    if (!grant) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }

    const sessionId = request.header("mcp-session-id");
    let connection = sessionId ? connections.get(sessionId) : undefined;
    if (connection && connection.authorization !== authorization) {
      response.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (!connection && !sessionId && isInitializeRequest(request.body)) {
      const server = createServer(grant);
      let transport: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized(id) {
          connections.set(id, { authorization, server, transport });
        },
        onsessionclosed(id) {
          connections.delete(id);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id) connections.delete(id);
      };
      connection = { authorization, server, transport };
      await server.connect(transport);
    }
    if (!connection) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null,
      });
      return;
    }

    try {
      await connection.transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);

  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("MCP server did not bind to a TCP port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    grant(parentId, agents) {
      const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
      grants.set(authorization, { parentId, agents: new Set(agents) });
      return authorization;
    },
    revoke(authorization) {
      grants.delete(authorization);
      for (const [id, connection] of connections) {
        if (connection.authorization !== authorization) continue;
        connections.delete(id);
        void connection.transport.close();
      }
    },
    async close() {
      grants.clear();
      await Promise.allSettled(
        [...connections.values()].map((connection) =>
          connection.transport.close(),
        ),
      );
      connections.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
