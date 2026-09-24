import { truncateToWidth } from "@earendil-works/pi-tui";
import { record, string, textContent } from "./protocol.ts";
import type { AgentRunSnapshot, AgentUsage } from "./runtime.ts";

export interface AgentTreeTheme {
  accent(text: string): string;
  dim(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  bold(text: string): string;
}

interface Activity {
  id?: string;
  status: "running" | "completed" | "failed" | "text";
  text: string;
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 10000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1000000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1000000).toFixed(1)}m`;
}

function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function inputRecord(value: unknown): Record<string, unknown> {
  return record(value) ?? {};
}

function path(input: Record<string, unknown>): string {
  return string(input.file_path) ?? string(input.path) ?? "";
}

function formatTool(name: string, value: unknown): string {
  const input = inputRecord(value);
  const normalized = name.toLowerCase();
  if (normalized === "read") return `Read ${path(input)}`;
  if (normalized === "grep") {
    const pattern = string(input.pattern) ?? "";
    const location = path(input);
    return compact(
      `Grep ${JSON.stringify(pattern)} ${location && `in ${location}`}`,
    );
  }
  if (normalized === "glob" || normalized === "find" || normalized === "ls") {
    return compact(`${name} ${string(input.pattern) ?? path(input)}`);
  }
  if (normalized === "bash") {
    return `Bash ${compact(string(input.command) ?? "")}`;
  }
  if (normalized === "edit" || normalized === "write") {
    return `${name} ${path(input)}`;
  }
  if (normalized === "websearch" || normalized === "web_search") {
    return `WebSearch ${compact(string(input.query) ?? "")}`;
  }
  if (normalized === "webfetch" || normalized === "web_fetch") {
    return `WebFetch ${string(input.url) ?? ""}`;
  }
  if (normalized.endsWith("subagent_message")) {
    return compact(
      `subagent_message ${string(input.id) ?? "child"} ${JSON.stringify(string(input.message) ?? "")}`,
    );
  }
  if (normalized.endsWith("subagent_stop")) {
    return `subagent_stop ${string(input.id) ?? "child"}`;
  }
  if (normalized.endsWith("subagent_list")) return "subagent_list";
  if (normalized.endsWith("subagent_ask")) {
    return compact(
      `subagent_ask ${JSON.stringify(string(input.prompt) ?? "")}`,
    );
  }
  if (normalized.endsWith("subagent")) {
    return compact(
      `subagent ${string(input.id) ?? "child"} ${string(input.name) ?? "agent"} ${JSON.stringify(string(input.prompt) ?? "")}`,
    );
  }
  const serialized = JSON.stringify(value);
  return compact(`${name}${serialized ? ` ${serialized}` : ""}`);
}

function activities(run: AgentRunSnapshot): Activity[] {
  const values: Activity[] = [];
  const tools = new Map<string, Activity>();
  for (const event of run.events) {
    if (event.type === "tool_start") {
      const activity: Activity = {
        id: event.id,
        status: "running",
        text: formatTool(event.name, event.input),
      };
      tools.set(event.id, activity);
      values.push(activity);
    }
    if (event.type === "tool_end") {
      const activity = tools.get(event.id);
      if (activity) activity.status = event.isError ? "failed" : "completed";
    }
    if (event.type === "message" && event.message.role === "assistant") {
      const text = compact(textContent(event.message.content));
      if (text) values.push({ status: "text", text: `"${text}"` });
    }
  }
  if (run.error) values.push({ status: "failed", text: compact(run.error) });
  return values;
}

function addUsage(target: AgentUsage, source: AgentUsage): void {
  target.inputTokens += source.inputTokens;
  target.outputTokens += source.outputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  if (source.costUsd !== undefined)
    target.costUsd = (target.costUsd ?? 0) + source.costUsd;
}

function formatUsage(usage: AgentUsage): string {
  const values: string[] = [];
  if (usage.contextTokens !== undefined)
    values.push(`ctx ${formatCount(usage.contextTokens)}`);
  values.push(`in ${formatCount(usage.inputTokens)}`);
  values.push(`out ${formatCount(usage.outputTokens)}`);
  const cache = usage.cacheReadTokens + usage.cacheWriteTokens;
  values.push(`cache ${formatCount(cache)}`);
  values.push(
    usage.costUsd === undefined ? "cost n/a" : `$${usage.costUsd.toFixed(2)}`,
  );
  return values.join(" | ");
}

function status(run: AgentRunSnapshot, theme: AgentTreeTheme): string {
  if (run.status === "running") return theme.warning("[>]");
  if (run.status === "waiting") return theme.warning("[?]");
  if (run.status === "completed") return theme.success("[ok]");
  if (run.status === "failed") return theme.error("[x]");
  return theme.muted("[-]");
}

export function agentSubtree(
  runs: AgentRunSnapshot[],
  rootId: string,
): AgentRunSnapshot[] {
  const included = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of runs) {
      if (
        run.parentRunId &&
        included.has(run.parentRunId) &&
        !included.has(run.runId)
      ) {
        included.add(run.runId);
        changed = true;
      }
    }
  }
  return runs.filter((run) => included.has(run.runId));
}

export function activeAgentTree(runs: AgentRunSnapshot[]): AgentRunSnapshot[] {
  const ids = new Set(runs.map((run) => run.runId));
  const roots = runs.filter(
    (run) => !run.parentRunId || !ids.has(run.parentRunId),
  );
  const activeRoots = roots.filter((root) =>
    agentSubtree(runs, root.runId).some(
      (run) => run.status === "running" || run.status === "waiting",
    ),
  );
  const included = new Set(
    activeRoots.flatMap((root) =>
      agentSubtree(runs, root.runId).map((run) => run.runId),
    ),
  );
  return runs.filter((run) => included.has(run.runId));
}

export function renderAgentTree(
  runs: AgentRunSnapshot[],
  width: number,
  theme: AgentTreeTheme,
  now: number,
  rows: "all" | "active" = "all",
): string[] {
  if (runs.length === 0 || width <= 0) return [];
  const displayedRuns = rows === "active" ? activeAgentTree(runs) : runs;
  if (displayedRuns.length === 0) return [];
  const byParent = new Map<string | undefined, AgentRunSnapshot[]>();
  const ids = new Set(displayedRuns.map((run) => run.runId));
  for (const run of displayedRuns) {
    const parent =
      run.parentRunId && ids.has(run.parentRunId) ? run.parentRunId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(run);
    byParent.set(parent, siblings);
  }
  for (const siblings of byParent.values())
    siblings.sort((left, right) => left.startedAt - right.startedAt);

  const usage: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const run of runs) addUsage(usage, run.usage);
  const tokenTotal =
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens;
  const completed = runs.filter(
    (run) => run.status !== "running" && run.status !== "waiting",
  ).length;
  const cost =
    usage.costUsd === undefined ? "n/a" : `$${usage.costUsd.toFixed(2)}`;
  const lines = [
    theme.bold(
      `Subagents  total: ${runs.length}  completed: ${completed}  tokens: ${formatCount(tokenTotal)}  cost: ${cost}`,
    ),
  ];

  const append = (
    run: AgentRunSnapshot,
    prefix: string,
    connector: string,
    last: boolean,
  ) => {
    const elapsed = formatDuration(run.startedAt, run.endedAt ?? now);
    lines.push(
      `${prefix}${connector}${status(run, theme)} ${theme.accent(theme.bold(`${run.agent}:${run.id}`))} ${theme.muted(`${run.harness}/${run.model}`)} ${theme.dim(`think:${run.thinking} ${elapsed}`)} ${theme.dim(formatUsage(run.usage))}`,
    );
    const continuation = connector ? `${prefix}${last ? "    " : "|   "}` : "";
    const active = run.status === "running" || run.status === "waiting";
    const recent = active ? activities(run) : [];
    const omitted = Math.max(0, recent.length - 3);
    if (omitted > 0)
      lines.push(
        `${continuation}|  ${theme.muted(`... ${omitted} earlier events`)}`,
      );
    for (const activity of recent.slice(-3)) {
      const marker =
        activity.status === "running"
          ? theme.warning("[..]")
          : activity.status === "completed"
            ? theme.success("[ok]")
            : activity.status === "failed"
              ? theme.error("[x]")
              : "";
      lines.push(`${continuation}|  ${marker} ${theme.dim(activity.text)}`);
    }
    const children = byParent.get(run.runId) ?? [];
    children.forEach((child, index) =>
      append(
        child,
        continuation,
        index === children.length - 1 ? "`-- " : "+-- ",
        index === children.length - 1,
      ),
    );
  };

  const roots = byParent.get(undefined) ?? [];
  roots.forEach((root, index) => {
    if (index > 0) lines.push("");
    append(root, "", "", index === roots.length - 1);
  });
  return lines.map((line) => truncateToWidth(line, width));
}
