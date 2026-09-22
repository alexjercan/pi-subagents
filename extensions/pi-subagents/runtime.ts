import { randomUUID } from "node:crypto";
import {
  loadAgentProfiles,
  type AgentProfile,
  type LoadAgentProfilesOptions,
} from "./config.ts";
import {
  spawnHarness,
  type ClaudeThinkingLevel,
  type HarnessEvent,
  type HarnessResult,
  type HarnessRun,
  type HarnessUsage,
  type PiThinkingLevel,
} from "./harness.ts";
import { createDelegationHost, type DelegationHost } from "./mcp.ts";

export type AgentRunStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextTokens?: number;
  costUsd?: number;
}

export interface AgentRunSnapshot {
  runId: string;
  id: string;
  parentRunId?: string;
  agent: string;
  harness: "pi" | "claude";
  model: string;
  thinking: PiThinkingLevel | ClaudeThinkingLevel;
  pid: number;
  status: AgentRunStatus;
  question?: string;
  startedAt: number;
  endedAt?: number;
  usage: AgentUsage;
  events: HarnessEvent[];
  result?: HarnessResult;
  error?: string;
}

export interface AgentKind {
  name: string;
  description: string;
  harness: "pi" | "claude";
  model: string;
  thinking: PiThinkingLevel | ClaudeThinkingLevel;
}

export interface OwnedAgentRun {
  id: string;
  name: string;
  status: AgentRunStatus;
  question?: string;
  finalText?: string;
  error?: string;
}

export interface AgentInventory {
  kinds: AgentKind[];
  runs: OwnedAgentRun[];
}

export interface StartAgentRequest {
  id: string;
  name: string;
  prompt: string;
  parentRunId?: string;
}

export interface AgentRuntime {
  start(request: StartAgentRequest): Promise<AgentRunSnapshot>;
  message(
    ownerRunId: string | undefined,
    id: string,
    message: string,
  ): Promise<void>;
  inventory(ownerRunId?: string): Promise<AgentInventory>;
  list(): AgentRunSnapshot[];
  stopAll(): void;
  close(): Promise<void>;
}

export interface CreateAgentRuntimeOptions extends LoadAgentProfilesOptions {
  onUpdate?: (runs: AgentRunSnapshot[]) => void;
  onRootMessage?: (message: string) => void | Promise<void>;
  onRootQuestion?: (id: string, prompt: string) => void | Promise<void>;
}

interface PendingQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
}

function mergeUsage(current: AgentUsage, update: HarnessUsage): void {
  if (update.cumulative) {
    current.inputTokens = update.inputTokens;
    current.outputTokens = update.outputTokens;
    current.cacheReadTokens = update.cacheReadTokens;
    current.cacheWriteTokens = update.cacheWriteTokens;
  } else {
    current.inputTokens += update.inputTokens;
    current.outputTokens += update.outputTokens;
    current.cacheReadTokens += update.cacheReadTokens;
    current.cacheWriteTokens += update.cacheWriteTokens;
  }
  if (update.contextTokens !== undefined)
    current.contextTokens = update.contextTokens;
  if (update.costUsd !== undefined) {
    current.costUsd = update.cumulative
      ? update.costUsd
      : (current.costUsd ?? 0) + update.costUsd;
  }
}

function kind(profile: AgentProfile): AgentKind {
  return {
    name: profile.name,
    description: profile.description,
    harness: profile.config.harness,
    model: profile.config.model,
    thinking: profile.config.thinking,
  };
}

export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const snapshots = new Map<string, AgentRunSnapshot>();
  const active = new Map<string, HarnessRun>();
  const authorizations = new Map<string, string>();
  const questions = new Map<string, PendingQuestion>();
  const stateWaiters = new Map<string, Set<() => void>>();
  let closing = false;
  let host: DelegationHost;

  const list = () =>
    [...snapshots.values()].map((snapshot) => ({
      ...snapshot,
      usage: { ...snapshot.usage },
      events: [...snapshot.events],
    }));
  const emit = () => options.onUpdate?.(list());
  const signalState = (runId: string) => {
    const waiters = stateWaiters.get(runId);
    stateWaiters.delete(runId);
    for (const resolve of waiters ?? []) resolve();
  };
  const child = (ownerRunId: string | undefined, id: string) =>
    [...snapshots.values()].find(
      (snapshot) => snapshot.parentRunId === ownerRunId && snapshot.id === id,
    );
  const stopTree = (runId: string) => {
    for (const snapshot of snapshots.values()) {
      if (snapshot.parentRunId === runId) stopTree(snapshot.runId);
    }
    questions.get(runId)?.reject(new Error("Agent was cancelled"));
    questions.delete(runId);
    active.get(runId)?.stop();
  };
  const profiles = () => loadAgentProfiles(options);
  const allowedProfiles = async (ownerRunId?: string) => {
    const loaded = await profiles();
    if (!ownerRunId) return loaded;
    const owner = snapshots.get(ownerRunId);
    if (!owner) throw new Error("Unknown subagent owner");
    const ownerProfile = loaded.find((profile) => profile.name === owner.agent);
    const allowed = new Set(ownerProfile?.delegates ?? []);
    return loaded.filter((profile) => allowed.has(profile.name));
  };

  const ownedRun = (snapshot: AgentRunSnapshot): OwnedAgentRun => ({
    id: snapshot.id,
    name: snapshot.agent,
    status: snapshot.status,
    ...(snapshot.question === undefined ? {} : { question: snapshot.question }),
    ...(snapshot.result?.finalText
      ? { finalText: snapshot.result.finalText }
      : {}),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  });
  const inventory = async (ownerRunId?: string): Promise<AgentInventory> => ({
    kinds: (await allowedProfiles(ownerRunId)).map(kind),
    runs: [...snapshots.values()]
      .filter(
        (snapshot) =>
          snapshot.parentRunId === ownerRunId &&
          (snapshot.status === "running" || snapshot.status === "waiting"),
      )
      .map(ownedRun),
  });
  const waitForChild = async (
    ownerRunId: string,
    id: string,
  ): Promise<OwnedAgentRun> => {
    const snapshot = child(ownerRunId, id);
    if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
    while (snapshot.status === "running") {
      await new Promise<void>((resolve) => {
        const waiters = stateWaiters.get(snapshot.runId) ?? new Set();
        waiters.add(resolve);
        stateWaiters.set(snapshot.runId, waiters);
      });
    }
    return ownedRun(snapshot);
  };

  const message = async (
    ownerRunId: string | undefined,
    id: string,
    value: string,
  ) => {
    const snapshot = child(ownerRunId, id);
    if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
    const pending = questions.get(snapshot.runId);
    if (pending) {
      questions.delete(snapshot.runId);
      snapshot.question = undefined;
      snapshot.status = "running";
      pending.resolve(value);
      emit();
      return;
    }
    const run = active.get(snapshot.runId);
    if (!run || snapshot.status !== "running")
      throw new Error(`Subagent ${id} is not running`);
    await run.send(value);
  };

  const ask = async (
    runId: string,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> => {
    const snapshot = snapshots.get(runId);
    if (!snapshot || !active.has(runId))
      throw new Error("Agent is not running");
    if (questions.has(runId))
      throw new Error(`Subagent ${snapshot.id} already has a pending question`);
    snapshot.status = "waiting";
    snapshot.question = prompt;
    signalState(runId);
    emit();
    let rejectQuestion: (error: Error) => void = () => undefined;
    const answer = new Promise<string>((resolve, reject) => {
      rejectQuestion = reject;
      questions.set(runId, { resolve, reject });
    });
    const rejectPending = (error: Error) => {
      if (!questions.has(runId)) return;
      questions.delete(runId);
      snapshot.question = undefined;
      if (active.has(runId)) snapshot.status = "running";
      rejectQuestion(error);
      emit();
    };
    const abort = () => rejectPending(new Error("Question was cancelled"));
    if (signal.aborted) {
      abort();
      throw new Error("Question was cancelled");
    }
    signal.addEventListener("abort", abort, { once: true });
    if (!snapshot.parentRunId) {
      const onRootQuestion = options.onRootQuestion;
      if (!onRootQuestion) {
        rejectPending(new Error("Root question handler is not available"));
      } else {
        void (async () => onRootQuestion(snapshot.id, prompt))().catch(
          (error: unknown) =>
            rejectPending(
              error instanceof Error ? error : new Error(String(error)),
            ),
        );
      }
    }
    try {
      return await answer;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };

  const settle = async (snapshot: AgentRunSnapshot, run: HarnessRun) => {
    try {
      const result = await run.completion;
      snapshot.result = result;
      if (result.signal !== null) {
        snapshot.status = "cancelled";
        snapshot.error = "Agent was cancelled";
      } else if (result.exitCode !== 0) {
        snapshot.status = "failed";
        snapshot.error =
          result.stderr.trim() || `Agent exited with code ${result.exitCode}`;
      } else {
        snapshot.status = "completed";
      }
    } catch (error) {
      snapshot.status = "failed";
      snapshot.error = error instanceof Error ? error.message : String(error);
    } finally {
      snapshot.endedAt = Date.now();
      active.delete(snapshot.runId);
      questions
        .get(snapshot.runId)
        ?.reject(
          new Error(snapshot.error ?? "Agent completed before answering"),
        );
      questions.delete(snapshot.runId);
      for (const candidate of snapshots.values()) {
        if (candidate.parentRunId === snapshot.runId) stopTree(candidate.runId);
      }
      const authorization = authorizations.get(snapshot.runId);
      if (authorization) host.revoke(authorization);
      authorizations.delete(snapshot.runId);
      signalState(snapshot.runId);
      emit();
    }
    if (!closing && !snapshot.parentRunId) {
      const output =
        snapshot.result?.finalText || snapshot.error || "(no output)";
      try {
        await options.onRootMessage?.(
          `Subagent ${snapshot.id} finished with status ${snapshot.status}.\n${output}`,
        );
      } catch (error) {
        snapshot.error = `Could not wake owner: ${error instanceof Error ? error.message : String(error)}`;
        emit();
      }
    }
  };

  const start = async (
    request: StartAgentRequest,
  ): Promise<AgentRunSnapshot> => {
    if (!request.id) throw new Error("Subagent id must be a non-empty string");
    if (!request.name)
      throw new Error("Subagent name must be a non-empty string");
    if (!request.prompt)
      throw new Error("Subagent prompt must be a non-empty string");
    if (child(request.parentRunId, request.id))
      throw new Error(`Duplicate directly owned subagent id ${request.id}`);
    const allowed = await allowedProfiles(request.parentRunId);
    const profile = allowed.find(
      (candidate) => candidate.name === request.name,
    );
    if (!profile) {
      const names = allowed.map((candidate) => candidate.name).join(", ");
      throw new Error(
        `Unknown or disallowed agent ${request.name}. Available agents: ${names || "none"}`,
      );
    }

    const runId = randomUUID();
    const authorization = host.grant(runId, profile.delegates);
    let harnessRun: HarnessRun;
    try {
      harnessRun = spawnHarness(
        { cwd: options.cwd, prompt: request.prompt },
        profile.config,
        {
          system: profile.system,
          tools: profile.tools,
          delegation: { url: host.url, authorization },
        },
        (event) => {
          const snapshot = snapshots.get(runId);
          if (!snapshot) return;
          if (event.type === "usage") mergeUsage(snapshot.usage, event.usage);
          snapshot.events.push(event);
          emit();
        },
      );
    } catch (error) {
      host.revoke(authorization);
      throw error;
    }

    const snapshot: AgentRunSnapshot = {
      runId,
      id: request.id,
      parentRunId: request.parentRunId,
      agent: request.name,
      harness: profile.config.harness,
      model: profile.config.model,
      thinking: profile.config.thinking,
      pid: harnessRun.pid,
      status: "running",
      startedAt: Date.now(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      events: [],
    };
    snapshots.set(runId, snapshot);
    active.set(runId, harnessRun);
    authorizations.set(runId, authorization);
    emit();
    void settle(snapshot, harnessRun);
    return {
      ...snapshot,
      usage: { ...snapshot.usage },
      events: [...snapshot.events],
    };
  };

  host = await createDelegationHost({
    async start(callerRunId, id, name, prompt) {
      await start({ id, name, prompt, parentRunId: callerRunId });
      return waitForChild(callerRunId, id);
    },
    async message(callerRunId, id, value) {
      await message(callerRunId, id, value);
      return waitForChild(callerRunId, id);
    },
    list: (callerRunId) => inventory(callerRunId),
    ask,
  });

  return {
    start,
    message,
    inventory,
    list,
    stopAll() {
      for (const snapshot of snapshots.values()) {
        if (!snapshot.parentRunId) stopTree(snapshot.runId);
      }
    },
    async close() {
      closing = true;
      const runs = [...active.values()];
      for (const snapshot of snapshots.values()) {
        if (!snapshot.parentRunId) stopTree(snapshot.runId);
      }
      await Promise.allSettled(runs.map((run) => run.completion));
      await host.close();
    },
  };
}
