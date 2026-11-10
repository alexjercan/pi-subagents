import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createToolServer,
  type DelegationOperations,
  type Grant,
} from "./tools.ts";

interface HttpGrant {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  ready: Promise<void>;
}

export interface DelegationGrant {
  http(): { url: string; authorization: string };
  server(): McpServer;
  revoke(): void;
}

export interface DelegationHost {
  url: string;
  grant(callerRunId: string, agents: string[]): DelegationGrant;
  close(): Promise<void>;
}

function headers(request: IncomingMessage): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else if (value !== undefined) {
      result.set(name, value);
    }
  }
  return result;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function writeResponse(
  target: ServerResponse,
  source: Response,
): Promise<void> {
  target.statusCode = source.status;
  source.headers.forEach((value, name) => target.setHeader(name, value));
  if (!source.body) {
    target.end();
    return;
  }
  target.flushHeaders();
  await pipeline(
    Readable.fromWeb(source.body as ReadableStream<Uint8Array>),
    target,
  );
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = 500;
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
      id: null,
    }),
  );
}

export async function createDelegationHost(
  operations: DelegationOperations,
): Promise<DelegationHost> {
  const httpGrants = new Map<string, HttpGrant>();
  const servers = new Set<McpServer>();

  const handle = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (request.url !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const grant = httpGrants.get(authorization);
    if (!grant) {
      response.statusCode = 401;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const controller = new AbortController();
    request.once("aborted", () => controller.abort());
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const requestBody = await body(request);
    const method = request.method ?? "GET";
    const webRequest = new Request(`http://127.0.0.1${request.url}`, {
      method,
      headers: headers(request),
      body:
        method === "GET" || method === "HEAD" || requestBody.length === 0
          ? undefined
          : requestBody.toString("utf8"),
      signal: controller.signal,
    });
    await grant.ready;
    await writeResponse(
      response,
      await grant.transport.handleRequest(webRequest),
    );
  };

  const httpServer = createServer((request, response) => {
    void handle(request, response).catch((error) =>
      writeError(response, error),
    );
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", resolve);
    httpServer.once("error", reject);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    httpServer.close();
    throw new Error("MCP server did not bind to a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}/mcp`;

  return {
    url,
    grant(callerRunId, agents) {
      const grant: Grant = { callerRunId, agents: new Set(agents) };
      const owned = new Set<McpServer>();
      const authorizations = new Set<string>();
      const create = () => {
        const server = createToolServer(operations, grant);
        owned.add(server);
        servers.add(server);
        return server;
      };
      return {
        http() {
          const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
          const server = create();
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
          });
          httpGrants.set(authorization, {
            server,
            transport,
            ready: server.connect(transport),
          });
          authorizations.add(authorization);
          return { url, authorization };
        },
        server: create,
        revoke() {
          for (const authorization of authorizations)
            httpGrants.delete(authorization);
          authorizations.clear();
          for (const server of owned) {
            servers.delete(server);
            void server.close();
          }
          owned.clear();
        },
      };
    },
    async close() {
      const open = [...servers];
      httpGrants.clear();
      servers.clear();
      await Promise.allSettled(open.map((server) => server.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
