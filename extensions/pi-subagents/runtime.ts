import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
import {
  createDelegationHost,
  type DelegationGrant,
  type DelegationHost,
} from "./mcp.ts";
import { DELEGATION_GUIDANCE } from "./tools.ts";

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
  report?: string;
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
  create(request: StartAgentRequest): Promise<AgentRunSnapshot>;
  message(
    ownerRunId: string | undefined,
    id: string,
    message: string,
  ): Promise<void>;
  wait(
    ownerRunId: string | undefined,
    ids: string[] | undefined,
    signal: AbortSignal,
  ): Promise<string[]>;
  stop(ownerRunId: string | undefined, id: string): Promise<OwnedAgentRun>;
  inventory(ownerRunId?: string): Promise<AgentInventory>;
  list(): AgentRunSnapshot[];
  stopAll(): void;
  close(): Promise<void>;
}

export interface CreateAgentRuntimeOptions extends LoadAgentProfilesOptions {
  sessionsDir: string;
  onUpdate?: (runs: AgentRunSnapshot[]) => void;
  onRootMessage?: (message: string) => void | Promise<void>;
  onRootQuestion?: (id: string, prompt: string) => void | Promise<void>;
}

interface PendingQuestion {
  resolve(answer: string): void;
  reject(error: Error): void;
}

interface Notice {
  childRunId: string;
  text: string;
}

interface Waiter {
  childRunIds: Set<string>;
  resolve(notices: string[]): void;
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

function questionNotice(id: string, question: string): string {
  return `Subagent ${id} is waiting for an answer.\nQuestion: ${question}\nAnswer it with subagent_message using id ${id}.`;
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
  const grants = new Map<string, DelegationGrant>();
  const questions = new Map<string, PendingQuestion>();
  const stateWaiters = new Map<string, Set<() => void>>();
  const stopping = new Set<string>();
  const idleOwners = new Set<string>();
  const pendingNotifications = new Map<string, Notice[]>();
  const waiters = new Map<string | undefined, Set<Waiter>>();
  const delivering = new Set<string>();
  const deliveryFailures = new Map<string, string>();
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
    if (active.has(runId)) stopping.add(runId);
    for (const snapshot of snapshots.values()) {
      if (snapshot.parentRunId === runId) stopTree(snapshot.runId);
    }
    questions.get(runId)?.reject(new Error("Agent was cancelled"));
    questions.delete(runId);
    active.get(runId)?.stop();
  };
  const deliver = (ownerRunId: string) => {
    const run = active.get(ownerRunId);
    const notices = pendingNotifications.get(ownerRunId);
    if (!run || !notices?.length || stopping.has(ownerRunId) || closing) return;
    pendingNotifications.delete(ownerRunId);
    idleOwners.delete(ownerRunId);
    delivering.add(ownerRunId);
    void run
      .send(notices.map((notice) => notice.text).join("\n\n"))
      .catch((error: unknown) => {
        if (stopping.has(ownerRunId) || closing || !active.has(ownerRunId))
          return;
        deliveryFailures.set(
          ownerRunId,
          `Could not deliver child update: ${error instanceof Error ? error.message : String(error)}`,
        );
        stopTree(ownerRunId);
      });
  };
  const wake = (ownerRunId: string | undefined, notice: Notice): boolean => {
    const pending = waiters.get(ownerRunId);
    if (!pending) return false;
    for (const waiter of pending) {
      if (!waiter.childRunIds.has(notice.childRunId)) continue;
      pending.delete(waiter);
      if (pending.size === 0) waiters.delete(ownerRunId);
      const remaining = pendingNotifications.get(ownerRunId ?? "") ?? [];
      const taken = remaining.filter((candidate) =>
        waiter.childRunIds.has(candidate.childRunId),
      );
      const kept = remaining.filter(
        (candidate) => !waiter.childRunIds.has(candidate.childRunId),
      );
      if (ownerRunId !== undefined) {
        if (kept.length > 0) pendingNotifications.set(ownerRunId, kept);
        else pendingNotifications.delete(ownerRunId);
      }
      waiter.resolve([...taken, notice].map((candidate) => candidate.text));
      return true;
    }
    return false;
  };
  const notifyRoot = (notice: Notice) => {
    if (closing || wake(undefined, notice)) return;
    void (async () => options.onRootMessage?.(notice.text))().catch(
      () => undefined,
    );
  };
  const notifyOwner = (ownerRunId: string, notice: Notice) => {
    if (!active.has(ownerRunId) || stopping.has(ownerRunId) || closing) return;
    if (wake(ownerRunId, notice)) return;
    const notices = pendingNotifications.get(ownerRunId) ?? [];
    notices.push(notice);
    pendingNotifications.set(ownerRunId, notices);
    if (idleOwners.has(ownerRunId)) deliver(ownerRunId);
  };
  const turnSettled = (runId: string): boolean => {
    delivering.delete(runId);
    idleOwners.add(runId);
    const notices = pendingNotifications.get(runId) ?? [];
    for (const snapshot of snapshots.values()) {
      if (snapshot.parentRunId !== runId || snapshot.question === undefined)
        continue;
      const text = questionNotice(snapshot.id, snapshot.question);
      if (!notices.some((notice) => notice.text === text))
        notices.push({ childRunId: snapshot.runId, text });
    }
    if (notices.length > 0) {
      pendingNotifications.set(runId, notices);
      deliver(runId);
      return false;
    }
    if (
      [...snapshots.values()].some(
        (run) => run.parentRunId === runId && active.has(run.runId),
      )
    )
      return false;
    idleOwners.delete(runId);
    return true;
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
    ...(snapshot.result?.report ? { report: snapshot.result.report } : {}),
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
  const nextState = (runId: string) =>
    new Promise<void>((resolve) => {
      const waiters = stateWaiters.get(runId) ?? new Set();
      waiters.add(resolve);
      stateWaiters.set(runId, waiters);
    });
  const stop = async (
    ownerRunId: string | undefined,
    id: string,
  ): Promise<OwnedAgentRun> => {
    const snapshot = child(ownerRunId, id);
    if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
    const live = () =>
      snapshot.status === "running" || snapshot.status === "waiting";
    if (!live() || stopping.has(snapshot.runId))
      throw new Error(`Subagent ${id} is not running`);
    stopTree(snapshot.runId);
    while (live()) await nextState(snapshot.runId);
    if (snapshot.status !== "cancelled")
      throw new Error(
        `Subagent ${id} ${snapshot.status} before it was cancelled`,
      );
    return ownedRun(snapshot);
  };

  const wait = async (
    ownerRunId: string | undefined,
    ids: string[] | undefined,
    signal: AbortSignal,
  ): Promise<string[]> => {
    const children = [...snapshots.values()].filter(
      (snapshot) => snapshot.parentRunId === ownerRunId,
    );
    const targets =
      ids === undefined
        ? children
        : ids.map((id) => {
            const found = children.find((snapshot) => snapshot.id === id);
            if (!found)
              throw new Error(`Unknown directly owned subagent ${id}`);
            return found;
          });
    if (targets.length === 0) throw new Error("No directly owned subagents");
    const childRunIds = new Set(targets.map((snapshot) => snapshot.runId));
    const pending = pendingNotifications.get(ownerRunId ?? "") ?? [];
    const ready = pending.filter((notice) =>
      childRunIds.has(notice.childRunId),
    );
    if (ready.length > 0 && ownerRunId !== undefined) {
      const kept = pending.filter(
        (notice) => !childRunIds.has(notice.childRunId),
      );
      if (kept.length > 0) pendingNotifications.set(ownerRunId, kept);
      else pendingNotifications.delete(ownerRunId);
      return ready.map((notice) => notice.text);
    }
    if (!targets.some((snapshot) => snapshot.status === "running"))
      throw new Error(
        `No subagent to wait for: ${targets
          .map((snapshot) => `${snapshot.id} is ${snapshot.status}`)
          .join(", ")}`,
      );
    if (signal.aborted) throw new Error("Wait was cancelled");
    return await new Promise<string[]>((resolve, reject) => {
      const waiter: Waiter = { childRunIds, resolve, reject };
      const set = waiters.get(ownerRunId) ?? new Set();
      set.add(waiter);
      waiters.set(ownerRunId, set);
      signal.addEventListener(
        "abort",
        () => {
          set.delete(waiter);
          if (set.size === 0) waiters.delete(ownerRunId);
          reject(new Error("Wait was cancelled"));
        },
        { once: true },
      );
    });
  };

  const message = async (
    ownerRunId: string | undefined,
    id: string,
    value: string,
  ) => {
    const snapshot = child(ownerRunId, id);
    if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
    if (stopping.has(snapshot.runId))
      throw new Error(`Subagent ${id} is not running`);
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
    if (!snapshot || !active.has(runId) || stopping.has(runId))
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
    if (snapshot.parentRunId)
      notifyOwner(snapshot.parentRunId, {
        childRunId: runId,
        text: questionNotice(snapshot.id, prompt),
      });
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
      const deliveryFailure = deliveryFailures.get(snapshot.runId);
      const unfinishedChild = [...snapshots.values()].some(
        (candidate) =>
          candidate.parentRunId === snapshot.runId &&
          active.has(candidate.runId),
      );
      if (deliveryFailure) {
        snapshot.status = "failed";
        snapshot.error = deliveryFailure;
      } else if (stopping.has(snapshot.runId) && !result.finished) {
        snapshot.status = "cancelled";
        snapshot.error = "Agent was cancelled";
      } else if (result.signal !== null) {
        snapshot.status = "failed";
        snapshot.error = `Agent was terminated by ${result.signal}`;
      } else if (result.exitCode !== 0) {
        snapshot.status = "failed";
        snapshot.error =
          result.stderr.trim() || `Agent exited with code ${result.exitCode}`;
      } else if (
        !closing &&
        (unfinishedChild ||
          pendingNotifications.has(snapshot.runId) ||
          delivering.has(snapshot.runId))
      ) {
        snapshot.status = "failed";
        snapshot.error = "Agent exited before receiving child updates";
      } else {
        snapshot.status = "completed";
      }
    } catch (error) {
      snapshot.status = "failed";
      snapshot.error = error instanceof Error ? error.message : String(error);
    } finally {
      snapshot.endedAt = Date.now();
      active.delete(snapshot.runId);
      stopping.delete(snapshot.runId);
      idleOwners.delete(snapshot.runId);
      pendingNotifications.delete(snapshot.runId);
      delivering.delete(snapshot.runId);
      deliveryFailures.delete(snapshot.runId);
      questions
        .get(snapshot.runId)
        ?.reject(
          new Error(snapshot.error ?? "Agent completed before answering"),
        );
      questions.delete(snapshot.runId);
      snapshot.question = undefined;
      for (const candidate of snapshots.values()) {
        if (candidate.parentRunId === snapshot.runId) stopTree(candidate.runId);
      }
      grants.get(snapshot.runId)?.revoke();
      grants.delete(snapshot.runId);
      signalState(snapshot.runId);
      emit();
    }
    const output = snapshot.error
      ? `${snapshot.error}${snapshot.result?.report ? `\n${snapshot.result.report}` : ""}`
      : snapshot.result?.report || "(no output)";
    const notice: Notice = {
      childRunId: snapshot.runId,
      text: `Subagent ${snapshot.id} finished with status ${snapshot.status}.\n${output}`,
    };
    if (closing) return;
    if (snapshot.parentRunId) notifyOwner(snapshot.parentRunId, notice);
    else notifyRoot(notice);
  };

  const create = async (
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
    if (request.parentRunId && stopping.has(request.parentRunId))
      throw new Error("Agent is not running");
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
    await mkdir(options.sessionsDir, { recursive: true });
    const delegating = profile.delegates.length > 0;
    const grant = delegating ? host.grant(runId, profile.delegates) : undefined;
    let harnessRun: HarnessRun;
    try {
      harnessRun = spawnHarness(
        {
          cwd: options.cwd,
          prompt: request.prompt,
          runId,
          resume: false,
          sessionsDir: options.sessionsDir,
        },
        profile.config,
        {
          system: delegating
            ? `${profile.system}\n\n${DELEGATION_GUIDANCE}`
            : profile.system,
          tools: profile.tools,
          ...(grant ? { delegation: grant } : {}),
          onTurnSettled: () => turnSettled(runId),
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
      grant?.revoke();
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
    if (grant) grants.set(runId, grant);
    emit();
    void settle(snapshot, harnessRun);
    return {
      ...snapshot,
      usage: { ...snapshot.usage },
      events: [...snapshot.events],
    };
  };

  host = await createDelegationHost({
    async create(callerRunId, id, name, prompt) {
      await create({ id, name, prompt, parentRunId: callerRunId });
      const snapshot = child(callerRunId, id);
      if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
      return ownedRun(snapshot);
    },
    async message(callerRunId, id, value) {
      await message(callerRunId, id, value);
      const snapshot = child(callerRunId, id);
      if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
      return ownedRun(snapshot);
    },
    wait,
    stop,
    list: (callerRunId) => inventory(callerRunId),
    ask,
  });

  return {
    create,
    message,
    wait,
    stop,
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
