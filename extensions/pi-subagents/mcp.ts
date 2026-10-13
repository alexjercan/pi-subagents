import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";

const PROGRESS_INTERVAL_MS = 30000;

interface Grant {
  callerRunId: string;
  agents: Set<string>;
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  ready: Promise<void>;
}

export interface DelegationOperations {
  start(
    callerRunId: string,
    id: string,
    name: string,
    prompt: string,
  ): Promise<unknown>;
  message(callerRunId: string, id: string, message: string): Promise<unknown>;
  stop(callerRunId: string, id: string): Promise<unknown>;
  list(callerRunId: string): Promise<unknown>;
  ask(
    callerRunId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string>;
}

export interface DelegationHost {
  url: string;
  grant(callerRunId: string, agents: string[]): string;
  revoke(authorization: string): void;
  close(): Promise<void>;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
  };
}

function failure(error: unknown) {
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

async function withProgress<T>(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  work: () => Promise<T>,
): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return await work();
  let progress = 0;
  const timer = setInterval(() => {
    progress += 1;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress },
      })
      .catch(() => undefined);
  }, PROGRESS_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
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
  const grants = new Map<string, Grant>();

  const createToolServer = (grant: Grant) => {
    const server = new McpServer({ name: "pi-subagents", version: "0.1.0" });
    server.registerTool(
      "subagent",
      {
        description:
          "Start a configured direct child and return its current state. Child completion and questions are sent to this owner automatically.",
        inputSchema: {
          id: z.string().min(1),
          name: z.string().min(1),
          prompt: z.string().min(1),
        },
      },
      async ({ id, name, prompt }) => {
        if (!grant.agents.has(name))
          return failure(`Agent ${name} is not an allowed delegate`);
        try {
          return text(
            await operations.start(grant.callerRunId, id, name, prompt),
          );
        } catch (error) {
          return failure(error);
        }
      },
    );
    server.registerTool(
      "subagent_message",
      {
        description:
          "Send a message to a directly owned child and return its current state. Child completion and questions are sent to this owner automatically.",
        inputSchema: {
          id: z.string().min(1),
          message: z.string().min(1),
        },
      },
      async ({ id, message }) => {
        try {
          return text(await operations.message(grant.callerRunId, id, message));
        } catch (error) {
          return failure(error);
        }
      },
    );
    server.registerTool(
      "subagent_stop",
      {
        description:
          "Stop a directly owned child and its subtree and wait for its final state.",
        inputSchema: { id: z.string().min(1) },
      },
      async ({ id }, extra) => {
        try {
          return text(
            await withProgress(extra, () =>
              operations.stop(grant.callerRunId, id),
            ),
          );
        } catch (error) {
          return failure(error);
        }
      },
    );
    server.registerTool(
      "subagent_list",
      {
        description: "List allowed agent kinds and directly owned runs.",
        inputSchema: {},
      },
      async () => {
        try {
          return text(await operations.list(grant.callerRunId));
        } catch (error) {
          return failure(error);
        }
      },
    );
    server.registerTool(
      "subagent_ask",
      {
        description: "Ask the direct owner a question and wait for its answer.",
        inputSchema: { prompt: z.string().min(1) },
      },
      async ({ prompt }, extra) => {
        try {
          return text(
            await withProgress(extra, () =>
              operations.ask(grant.callerRunId, prompt, extra.signal),
            ),
          );
        } catch (error) {
          return failure(error);
        }
      },
    );
    return server;
  };

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
    const grant = grants.get(authorization);
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

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    grant(callerRunId, agents) {
      const authorization = `Bearer ${randomBytes(32).toString("hex")}`;
      const grant = {
        callerRunId,
        agents: new Set(agents),
      } as Grant;
      grant.transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
      });
      grant.server = createToolServer(grant);
      grant.ready = grant.server.connect(grant.transport);
      grants.set(authorization, grant);
      return authorization;
    },
    revoke(authorization) {
      const grant = grants.get(authorization);
      grants.delete(authorization);
      if (grant) void grant.server.close();
    },
    async close() {
      const servers = [...grants.values()].map((grant) => grant.server);
      grants.clear();
      await Promise.allSettled(servers.map((server) => server.close()));
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}
