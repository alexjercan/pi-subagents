import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { HarnessEvent } from "../extensions/pi-subagents/harness.ts";
import type { AgentRunSnapshot } from "../extensions/pi-subagents/runtime.ts";
import {
  activeAgentTree,
  renderAgentTree,
  type AgentTreeTheme,
} from "../extensions/pi-subagents/ui.ts";

const theme: AgentTreeTheme = {
  accent: (text) => text,
  dim: (text) => text,
  error: (text) => text,
  muted: (text) => text,
  success: (text) => text,
  warning: (text) => text,
  bold: (text) => text,
};

function run(
  value: Partial<AgentRunSnapshot> & Pick<AgentRunSnapshot, "id" | "agent">,
): AgentRunSnapshot {
  return {
    runId: value.runId ?? value.id,
    id: value.id,
    parentRunId: value.parentRunId,
    agent: value.agent,
    harness: value.harness ?? "claude",
    model: value.model ?? "haiku",
    thinking: value.thinking ?? "medium",
    pid: value.pid ?? 100,
    status: value.status ?? "completed",
    startedAt: value.startedAt ?? 1000,
    endedAt: value.endedAt,
    usage: value.usage ?? {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 300,
      cacheWriteTokens: 100,
      contextTokens: 1600,
      costUsd: 0.12,
    },
    events: value.events ?? [],
    result: value.result,
    error: value.error,
  };
}

function message(text: string): HarnessEvent {
  return {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      value: {},
    },
  };
}

test("Agent tree renders hierarchy, metadata, usage, and start order", () => {
  const runs = [
    run({
      id: "worker",
      agent: "worker",
      model: "opus",
      thinking: "high",
      status: "running",
      startedAt: 1000,
    }),
    run({
      id: "later",
      parentRunId: "worker",
      agent: "review",
      model: "sonnet",
      startedAt: 3000,
      endedAt: 5000,
    }),
    run({
      id: "earlier",
      parentRunId: "worker",
      agent: "scout",
      startedAt: 2000,
      endedAt: 4000,
      events: [message("scout note")],
    }),
  ];
  const lines = renderAgentTree(runs, 120, theme, 61000);
  assert.equal(lines.length, 4);
  assert.match(lines[0] ?? "", /total: 3  completed: 2/);
  assert.match(
    lines[1] ?? "",
    /worker:worker claude\/opus think:high 01:00 ctx 1.6k \| in 1.0k.*\$0.12/,
  );
  assert.match(
    lines[2] ?? "",
    /\+-- \[ok\] scout:earlier .*ctx 1.6k \| in 1.0k.*\$0.12/,
  );
  assert.match(lines[3] ?? "", /`-- \[ok\] review:later/);
  assert.ok(lines.every((line) => !line.includes("scout note")));
});

test("Active agent tree retains cumulative session totals", () => {
  const runs = [
    run({ id: "completed", agent: "scout" }),
    run({ id: "failed", agent: "review", status: "failed" }),
    run({ id: "cancelled", agent: "worker", status: "cancelled" }),
    run({ id: "active", agent: "scout", status: "running" }),
  ];
  const lines = renderAgentTree(runs, 120, theme, 5000, "active");
  assert.match(
    lines[0] ?? "",
    /total: 4  completed: 3  tokens: 6.4k  cost: \$0.48/,
  );
  assert.ok(lines.some((line) => line.includes("scout:active")));
  assert.ok(lines.every((line) => !line.includes("scout:completed")));
  assert.ok(lines.every((line) => !line.includes("review:failed")));
  assert.ok(lines.every((line) => !line.includes("worker:cancelled")));
});

test("Agent tree keeps three recent one-line activities", () => {
  const events = [
    message("first output"),
    message("second output"),
    {
      type: "tool_start" as const,
      id: "read",
      name: "Read",
      input: { file_path: "src/very-long-file.ts" },
    },
    {
      type: "tool_end" as const,
      id: "read",
      name: "Read",
      output: "contents",
      isError: false,
    },
    message("third\noutput"),
    message("fourth output"),
  ];
  const lines = renderAgentTree(
    [run({ id: "worker", agent: "worker", status: "running", events })],
    54,
    theme,
    5000,
  );
  assert.ok(lines.some((line) => line.includes("... 2 earlier events")));
  assert.ok(lines.some((line) => line.includes("Read src/very-long")));
  assert.ok(lines.some((line) => line.includes('"third output"')));
  assert.ok(lines.some((line) => line.includes('"fourth output"')));
  assert.ok(lines.every((line) => visibleWidth(line) <= 54));
  assert.ok(lines.every((line) => !line.includes("first output")));
});

test("Active tree includes completed children only under running roots", () => {
  const runs = [
    run({ id: "old", agent: "review" }),
    run({ id: "worker", agent: "worker", status: "running" }),
    run({ id: "scout", parentRunId: "worker", agent: "scout" }),
  ];
  assert.deepEqual(
    activeAgentTree(runs).map((candidate) => candidate.id),
    ["worker", "scout"],
  );
  assert.deepEqual(
    activeAgentTree(
      runs.map((candidate) => ({ ...candidate, status: "completed" })),
    ),
    [],
  );
});
