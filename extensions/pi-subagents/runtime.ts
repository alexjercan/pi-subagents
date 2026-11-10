import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  loadAgentProfiles,
  type AgentProfile,
  type LoadAgentProfilesOptions,
} from "./config.ts";
import {
  harnessSession,
  spawnHarness,
  type ClaudeThinkingLevel,
  type HarnessEvent,
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
  | "idle"
  | "stopped"
  | "failed";

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
  session: string;
  report?: string;
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

export type SubagentLogEvent =
  | "create"
  | "resume"
  | "message"
  | "ask"
  | "answer"
  | "wait"
  | "stop"
  | "idle"
  | "failed";

export interface SubagentLogEntry {
  at: number;
  runId: string;
  id: string;
  parentRunId?: string;
  agent: string;
  harness: "pi" | "claude";
  model: string;
  event: SubagentLogEvent;
  text?: string;
  usage?: AgentUsage;
  pid?: number;
  session?: string;
}

export interface CreateAgentRuntimeOptions extends LoadAgentProfilesOptions {
  sessionsDir: string;
  onUpdate?: (runs: AgentRunSnapshot[]) => void;
  onRootMessage?: (message: string) => void | Promise<void>;
  onRootQuestion?: (id: string, prompt: string) => void | Promise<void>;
  onEntry?: (entry: SubagentLogEntry) => void;
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

function endNotice(snapshot: AgentRunSnapshot): string {
  if (snapshot.status === "stopped")
    return `Subagent ${snapshot.id} was stopped.`;
  if (snapshot.status === "failed")
    return `Subagent ${snapshot.id} failed.\n${snapshot.error}${snapshot.report ? `\n${snapshot.report}` : ""}`;
  return `Subagent ${snapshot.id} is idle.\n${snapshot.report ?? "(no output)"}`;
}

function live(snapshot: AgentRunSnapshot): boolean {
  return snapshot.status === "running" || snapshot.status === "waiting";
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
  const profilesByRun = new Map<string, AgentProfile>();
  const active = new Map<string, HarnessRun>();
  const grants = new Map<string, DelegationGrant>();
  const questions = new Map<string, PendingQuestion>();
  const stateWaiters = new Map<string, Set<() => void>>();
  const stopping = new Set<string>();
  const settledOwners = new Set<string>();
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
  const log = (
    snapshot: AgentRunSnapshot,
    event: SubagentLogEvent,
    text?: string,
  ) => {
    const onEntry = options.onEntry;
    if (!onEntry) return;
    const entry: SubagentLogEntry = {
      at: Date.now(),
      runId: snapshot.runId,
      id: snapshot.id,
      ...(snapshot.parentRunId === undefined
        ? {}
        : { parentRunId: snapshot.parentRunId }),
      agent: snapshot.agent,
      harness: snapshot.harness,
      model: snapshot.model,
      event,
      ...(text === undefined ? {} : { text }),
      usage: { ...snapshot.usage },
      pid: snapshot.pid,
      session: snapshot.session,
    };
    try {
      onEntry(entry);
    } catch {
      return;
    }
  };
  const signalState = (runId: string) => {
    const waiters = stateWaiters.get(runId);
    stateWaiters.delete(runId);
    for (const resolve of waiters ?? []) resolve();
  };
  const child = (ownerRunId: string | undefined, id: string) =>
    [...snapshots.values()].find(
      (snapshot) => snapshot.parentRunId === ownerRunId && snapshot.id === id,
    );
  const children = (runId: string | undefined) =>
    [...snapshots.values()].filter(
      (snapshot) => snapshot.parentRunId === runId,
    );
  const notify = (snapshot: AgentRunSnapshot) => {
    if (closing) return;
    const notice: Notice = {
      childRunId: snapshot.runId,
      text: endNotice(snapshot),
    };
    if (snapshot.parentRunId) notifyOwner(snapshot.parentRunId, notice);
    else notifyRoot(notice);
  };
  const releaseGrant = (runId: string) => {
    grants.get(runId)?.revoke();
    grants.delete(runId);
  };
  const markStopped = (snapshot: AgentRunSnapshot) => {
    snapshot.status = "stopped";
    snapshot.endedAt = Date.now();
    for (const candidate of children(snapshot.runId)) stopTree(candidate.runId);
    releaseGrant(snapshot.runId);
    signalState(snapshot.runId);
    log(snapshot, "stop");
    emit();
    notify(snapshot);
  };
  const stopTree = (runId: string) => {
    const snapshot = snapshots.get(runId);
    if (!snapshot) return;
    if (active.has(runId)) {
      stopping.add(runId);
      for (const candidate of children(runId)) stopTree(candidate.runId);
      questions.get(runId)?.reject(new Error("Agent was stopped"));
      questions.delete(runId);
      active.get(runId)?.stop();
      return;
    }
    if (snapshot.status === "idle") markStopped(snapshot);
  };
  const deliver = (ownerRunId: string) => {
    const run = active.get(ownerRunId);
    const notices = pendingNotifications.get(ownerRunId);
    if (!run || !notices?.length || stopping.has(ownerRunId) || closing) return;
    pendingNotifications.delete(ownerRunId);
    settledOwners.delete(ownerRunId);
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
    if (settledOwners.has(ownerRunId)) deliver(ownerRunId);
  };
  const turnSettled = (runId: string): boolean => {
    delivering.delete(runId);
    settledOwners.add(runId);
    const notices = pendingNotifications.get(runId) ?? [];
    for (const snapshot of children(runId)) {
      if (snapshot.question === undefined) continue;
      const text = questionNotice(snapshot.id, snapshot.question);
      if (!notices.some((notice) => notice.text === text))
        notices.push({ childRunId: snapshot.runId, text });
    }
    if (notices.length > 0) {
      pendingNotifications.set(runId, notices);
      deliver(runId);
      return false;
    }
    if (children(runId).some((run) => active.has(run.runId))) return false;
    settledOwners.delete(runId);
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
    ...(snapshot.report === undefined ? {} : { report: snapshot.report }),
    ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
  });
  const inventory = async (ownerRunId?: string): Promise<AgentInventory> => ({
    kinds: (await allowedProfiles(ownerRunId)).map(kind),
    runs: children(ownerRunId)
      .filter((snapshot) => live(snapshot) || snapshot.status === "idle")
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
    if (stopping.has(snapshot.runId))
      throw new Error(`Subagent ${id} is stopping`);
    if (snapshot.status === "idle") {
      markStopped(snapshot);
      return ownedRun(snapshot);
    }
    if (!live(snapshot))
      throw new Error(`Subagent ${id} is ${snapshot.status}`);
    stopTree(snapshot.runId);
    while (live(snapshot)) await nextState(snapshot.runId);
    return ownedRun(snapshot);
  };

  const wait = async (
    ownerRunId: string | undefined,
    ids: string[] | undefined,
    signal: AbortSignal,
  ): Promise<string[]> => {
    const owned = children(ownerRunId);
    const targets =
      ids === undefined
        ? owned
        : ids.map((id) => {
            const found = owned.find((snapshot) => snapshot.id === id);
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
    const logWait = (notices: string[]) => {
      const owner =
        ownerRunId === undefined ? undefined : snapshots.get(ownerRunId);
      if (owner) log(owner, "wait", notices.join("\n\n"));
      return notices;
    };
    if (ready.length > 0 && ownerRunId !== undefined) {
      const kept = pending.filter(
        (notice) => !childRunIds.has(notice.childRunId),
      );
      if (kept.length > 0) pendingNotifications.set(ownerRunId, kept);
      else pendingNotifications.delete(ownerRunId);
      return logWait(ready.map((notice) => notice.text));
    }
    if (!targets.some(live))
      throw new Error(
        `No subagent to wait for: ${targets
          .map((snapshot) => `${snapshot.id} is ${snapshot.status}`)
          .join(", ")}`,
      );
    if (signal.aborted) throw new Error("Wait was cancelled");
    const notices = await new Promise<string[]>((resolve, reject) => {
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
    return logWait(notices);
  };

  const message = async (
    ownerRunId: string | undefined,
    id: string,
    value: string,
  ) => {
    const snapshot = child(ownerRunId, id);
    if (!snapshot) throw new Error(`Unknown directly owned subagent ${id}`);
    if (stopping.has(snapshot.runId))
      throw new Error(`Subagent ${id} is stopping`);
    const pending = questions.get(snapshot.runId);
    if (pending) {
      questions.delete(snapshot.runId);
      snapshot.question = undefined;
      snapshot.status = "running";
      pending.resolve(value);
      log(snapshot, "answer", value);
      emit();
      return;
    }
    if (snapshot.status === "idle") {
      const profile = profilesByRun.get(snapshot.runId);
      if (!profile) throw new Error(`Unknown subagent profile for ${id}`);
      spawn(snapshot, profile, value, true);
      log(snapshot, "resume", value);
      emit();
      return;
    }
    const run = active.get(snapshot.runId);
    if (!run || snapshot.status !== "running")
      throw new Error(`Subagent ${id} is ${snapshot.status}`);
    await run.send(value);
    log(snapshot, "message", value);
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
    log(snapshot, "ask", prompt);
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

  const settle = async (
    snapshot: AgentRunSnapshot,
    profile: AgentProfile,
    run: HarnessRun,
  ) => {
    const runId = snapshot.runId;
    const [completion] = await Promise.allSettled([run.completion]);
    const fail = (error: string) => {
      snapshot.status = "failed";
      snapshot.error = error;
    };
    try {
      snapshot.session = await harnessSession(profile.config, {
        cwd: options.cwd,
        runId,
        sessionsDir: options.sessionsDir,
      });
      if (completion.status === "rejected") throw completion.reason;
      const result = completion.value;
      if (result.report) snapshot.report = result.report;
      const deliveryFailure = deliveryFailures.get(runId);
      if (deliveryFailure) fail(deliveryFailure);
      else if (stopping.has(runId)) snapshot.status = "stopped";
      else if (result.signal !== null)
        fail(`Agent was terminated by ${result.signal}`);
      else if (result.exitCode !== 0)
        fail(
          result.stderr.trim() || `Agent exited with code ${result.exitCode}`,
        );
      else snapshot.status = "idle";
    } catch (error) {
      if (stopping.has(runId)) snapshot.status = "stopped";
      else fail(error instanceof Error ? error.message : String(error));
    }
    snapshot.endedAt = Date.now();
    active.delete(runId);
    stopping.delete(runId);
    settledOwners.delete(runId);
    pendingNotifications.delete(runId);
    delivering.delete(runId);
    deliveryFailures.delete(runId);
    questions
      .get(runId)
      ?.reject(new Error(snapshot.error ?? "Agent ended before answering"));
    questions.delete(runId);
    snapshot.question = undefined;
    if (snapshot.status !== "idle") {
      for (const candidate of children(runId)) stopTree(candidate.runId);
      releaseGrant(runId);
    }
    signalState(runId);
    if (snapshot.status === "stopped") log(snapshot, "stop");
    else if (snapshot.status === "failed")
      log(snapshot, "failed", snapshot.error);
    else log(snapshot, "idle", snapshot.report);
    emit();
    notify(snapshot);
  };

  const spawn = (
    snapshot: AgentRunSnapshot,
    profile: AgentProfile,
    prompt: string,
    resume: boolean,
  ) => {
    const runId = snapshot.runId;
    const delegating = profile.delegates.length > 0;
    const grant = delegating
      ? (grants.get(runId) ?? host.grant(runId, profile.delegates))
      : undefined;
    let harnessRun: HarnessRun;
    try {
      harnessRun = spawnHarness(
        {
          cwd: options.cwd,
          prompt,
          runId,
          resume,
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
          const current = snapshots.get(runId);
          if (!current) return;
          if (event.type === "usage") mergeUsage(current.usage, event.usage);
          current.events.push(event);
          emit();
        },
      );
    } catch (error) {
      grant?.revoke();
      grants.delete(runId);
      throw error;
    }
    if (grant) grants.set(runId, grant);
    snapshot.pid = harnessRun.pid;
    snapshot.status = "running";
    snapshot.endedAt = undefined;
    snapshot.report = undefined;
    snapshot.error = undefined;
    active.set(runId, harnessRun);
    void settle(snapshot, profile, harnessRun);
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
    const snapshot: AgentRunSnapshot = {
      runId,
      id: request.id,
      parentRunId: request.parentRunId,
      agent: request.name,
      harness: profile.config.harness,
      model: profile.config.model,
      thinking: profile.config.thinking,
      pid: 0,
      status: "running",
      startedAt: Date.now(),
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      events: [],
      session: await harnessSession(profile.config, {
        cwd: options.cwd,
        runId,
        sessionsDir: options.sessionsDir,
      }),
    };
    spawn(snapshot, profile, request.prompt, false);
    snapshots.set(runId, snapshot);
    profilesByRun.set(runId, profile);
    log(snapshot, "create", request.prompt);
    emit();
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
