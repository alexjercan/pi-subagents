import { randomUUID } from "node:crypto";
import { loadAgentProfiles, type LoadAgentProfilesOptions } from "./config.ts";
import {
  spawnHarness,
  type HarnessEvent,
  type HarnessResult,
  type HarnessRun,
} from "./harness.ts";
import { createDelegationHost, type DelegationHost } from "./mcp.ts";

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRunSnapshot {
  id: string;
  parentId?: string;
  agent: string;
  pid: number;
  status: AgentRunStatus;
  events: HarnessEvent[];
  result?: HarnessResult;
  error?: string;
}

export interface AgentRuntime {
  run(
    agent: string,
    task: string,
    parentId: string | undefined,
    signal: AbortSignal,
  ): Promise<AgentRunSnapshot>;
  list(): AgentRunSnapshot[];
  stopAll(): void;
  close(): Promise<void>;
}

export interface CreateAgentRuntimeOptions extends LoadAgentProfilesOptions {
  onUpdate?: (runs: AgentRunSnapshot[]) => void;
}

export async function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): Promise<AgentRuntime> {
  const snapshots = new Map<string, AgentRunSnapshot>();
  const active = new Map<string, HarnessRun>();
  let host: DelegationHost;

  const list = () =>
    [...snapshots.values()].map((snapshot) => ({
      ...snapshot,
      events: [...snapshot.events],
    }));
  const emit = () => options.onUpdate?.(list());
  const stopTree = (id: string) => {
    for (const snapshot of snapshots.values()) {
      if (snapshot.parentId === id) stopTree(snapshot.id);
    }
    active.get(id)?.stop();
  };

  const run = async (
    agent: string,
    task: string,
    parentId: string | undefined,
    signal: AbortSignal,
  ): Promise<AgentRunSnapshot> => {
    const profiles = await loadAgentProfiles(options);
    const profile = profiles.find((candidate) => candidate.name === agent);
    if (!profile) {
      const available = profiles.map((candidate) => candidate.name).join(", ");
      throw new Error(
        `Unknown agent ${agent}. Available agents: ${available || "none"}`,
      );
    }

    const id = randomUUID();
    let authorization: string | undefined;
    if (profile.config.harness === "claude" && profile.delegates.length > 0) {
      authorization = host.grant(id, profile.delegates);
    }
    const controller = new AbortController();
    const abort = () => {
      controller.abort();
      stopTree(id);
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });

    let harnessRun: HarnessRun;
    try {
      harnessRun = spawnHarness(
        { cwd: options.cwd, prompt: task },
        profile.config,
        {
          system: profile.system,
          tools: profile.tools,
          delegation: authorization
            ? { url: host.url, authorization }
            : undefined,
        },
        (event) => {
          const snapshot = snapshots.get(id);
          if (!snapshot) return;
          snapshot.events.push(event);
          emit();
        },
      );
    } catch (error) {
      if (authorization) host.revoke(authorization);
      signal.removeEventListener("abort", abort);
      throw error;
    }

    const snapshot: AgentRunSnapshot = {
      id,
      parentId,
      agent,
      pid: harnessRun.pid,
      status: "running",
      events: [],
    };
    snapshots.set(id, snapshot);
    active.set(id, harnessRun);
    if (controller.signal.aborted) harnessRun.stop();
    emit();

    try {
      const result = await harnessRun.completion;
      snapshot.result = result;
      if (controller.signal.aborted || result.signal !== null) {
        snapshot.status = "cancelled";
        snapshot.error = "Agent was cancelled";
        throw new Error(snapshot.error);
      }
      if (result.exitCode !== 0) {
        snapshot.status = "failed";
        snapshot.error =
          result.stderr.trim() || `Agent exited with code ${result.exitCode}`;
        throw new Error(snapshot.error);
      }
      snapshot.status = "completed";
      return { ...snapshot, events: [...snapshot.events] };
    } catch (error) {
      if (snapshot.status === "running") {
        snapshot.status = controller.signal.aborted ? "cancelled" : "failed";
        snapshot.error = error instanceof Error ? error.message : String(error);
      }
      throw error;
    } finally {
      active.delete(id);
      if (authorization) host.revoke(authorization);
      signal.removeEventListener("abort", abort);
      emit();
    }
  };

  host = await createDelegationHost(async (parentId, agent, task, signal) => {
    const snapshot = await run(agent, task, parentId, signal);
    return snapshot.result?.finalText ?? "";
  });

  return {
    run,
    list,
    stopAll() {
      for (const run of active.values()) run.stop();
    },
    async close() {
      for (const run of active.values()) run.stop();
      await Promise.allSettled(
        [...active.values()].map((run) => run.completion),
      );
      await host.close();
    },
  };
}
