# Redesign pi-subagents as v0.2.0: one tool contract, idle and resume lifecycle, background tasks, telemetry, commands

- STATUS: OPEN
- PRIORITY: 1
- TAGS: feature,runtime,mcp,ui


Source: review of 2026-10-13..11-10 sessions (nova-protocol, slop-dudes,
content-machine2, the-specimen-bevy; 2388 Claude children, $4951). Runtime is
reliable since v0.1.11, but children spend 17-22% of wall time in `sleep`
(69% waiting for their own background builds because background tasks are
disabled, 31% polling for their own children), Pi and Claude workers end runs
with prose questions or "waiting for handoff" and cannot be resumed, scouts
get delegation tools, and nothing is logged outside the two transcripts.

Approved 2026-11-10. No backward compatibility: old paths are deleted.

## Decisions

- Tool contract: `subagent_create`, `subagent_message`, `subagent_wait`,
  `subagent_list`, `subagent_stop`, `subagent_ask`, defined once in
  `tools.ts` and served to the root Pi (`registerTool`), Pi children (bridge
  over the HTTP MCP host), and Claude children (SDK MCP over the child's own
  stdio control frames with `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1`, so every
  surface sees the same bare names and schemas).
- Claude child: `initialize` control request with
  `sdkMcpServers: ["pi_subagents"]`, `sdkMcpServerConfigs.pi_subagents =
  { timeout: 2147483647, alwaysLoad: true }`; `mcp_message` frames answered
  through the grant's `McpServer` over `InMemoryTransport`; `--strict-mcp-config`
  kept; `--mcp-config`, `--allowedTools mcp__*`, Bearer grants for Claude die.
  Verified on Claude Code 2.1.316: a tool call held 100 s returned with
  `tool_progress` keepalives and no timeout.
- Lifecycle: statuses `running | waiting | idle | stopped | failed`.
  Turn end with no live children, no live background tasks, and no pending
  notices makes the run `idle`: process exits, session kept, report delivered
  to the owner. `subagent_message` on an idle run resumes it
  (Claude `--resume <runId>`, Pi `--session-id <runId> --session-dir <dir>`).
  `subagent_stop` on any live or idle run makes it `stopped`. `completed`,
  `cancelled`, `Agent exited before receiving child updates`, and the joined
  `reports[]` in `harness.ts` die.
- Sessions: Pi children drop `--no-session`; sessions dir
  `~/.pi/agent/subagents/<encoded cwd>/`. Claude keeps its default location.
  Verified on Pi 1.4.0: `--mode rpc --session-id X --session-dir D` creates
  and resumes.
- Background tasks: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` dies; keep
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`; a `result` settles the turn only
  when the live set from `background_tasks_changed` is empty. Verified on
  2.1.316: the CLI keeps running, takes a turn on `task_notification`, and
  emits a second `result`; the v0.1 "exit zero" was `harness.ts` ending input
  at the first `result`.
- `subagent_wait(ids?)`: blocks without timeout until any directly owned run
  in `ids` (default all) becomes idle, waiting, stopped, or failed; returns
  the notices; progress keepalives every 30 s; consumed notices are not
  re-delivered on turn end.
- `subagent_list` shows running, waiting, and idle direct children.
- Profiles without delegates get no tools at all; a leaf asks by ending its
  turn, and its owner resumes it.
- Tool descriptions and the runtime system preamble say: reports arrive when
  you end your turn or call `subagent_wait`; never sleep or poll; ask your
  owner with `subagent_ask` or by ending your turn.
- Telemetry: `SubagentLogEntry` for create, resume, message, ask, answer,
  wait, stop, idle, failed, with usage, pid, and session path, appended to the
  root session through `pi.appendEntry`.
- Commands: `/subagent-list`, `/subagent-show <id>`, `/subagent-create <name>
  <id> <prompt>`, `/subagent-message <id> <text>`, `/subagent-stop <id>`;
  missing id opens `ctx.ui.select`. User-created runs are owned by the root
  and report to the root model like model-created runs.
- Bundled example profiles get the slop-dudes ask wording.

## Interfaces

```ts
// tools.ts (new)
export const SUBAGENT_TOOLS: readonly ToolSpec[];
export interface ToolSpec { name; description; schema: z.ZodRawShape }
export function createToolServer(ops: DelegationOperations, grant: Grant): McpServer;
export function registerPiTools(pi: ExtensionAPI, call: (name, args, signal) => Promise<ToolResult>): void;

// runtime.ts
export type AgentRunStatus = "running" | "waiting" | "idle" | "stopped" | "failed";
export interface AgentRunSnapshot { ...; session: string; report?: string }
export interface AgentRuntime {
  create(request: StartAgentRequest): Promise<AgentRunSnapshot>;
  message(ownerRunId, id, message): Promise<void>;
  wait(ownerRunId, ids: string[] | undefined, signal): Promise<string[]>;
  stop(ownerRunId, id): Promise<OwnedAgentRun>;
  inventory(ownerRunId?): Promise<AgentInventory>;
  list(); stopAll(); close();
}
export interface CreateAgentRuntimeOptions { cwd; projectTrusted; sessionsDir: string;
  onUpdate?; onRootMessage?; onRootQuestion?; onEntry?: (entry: SubagentLogEntry) => void }
export interface SubagentLogEntry { at; runId; id; parentRunId?; agent; harness; model;
  event: "create" | "resume" | "message" | "ask" | "answer" | "wait" | "stop" | "idle" | "failed";
  text?; usage?; pid?; session? }

// harness.ts
export interface HarnessRequest { cwd; prompt; runId: string; resume: boolean; sessionsDir: string }
export interface HarnessLaunchOptions { system; tools?; onTurnSettled?: () => boolean;
  delegation?: { http: { url; authorization }; server(): McpServer } }
export interface HarnessResult { exitCode; signal; finished; report: string; stderr }

// protocol.ts
export interface HarnessAdapter { process; opening: unknown[]; prompt(message); normalize(value) }
export interface NormalizedRecord { events; finalText?; error?; settled?; reply?: unknown | Promise<unknown> }
```

## Slices and proofs

1. Contract and Claude stdio transport: fake `claude` fixture receives
   `initialize`, sends `mcp_message tools/call subagent_ask`, gets a
   `control_response` after a held answer; a scout profile launches with no
   server; real smoke: `subagent_ask` held 15 min returns.
2. Lifecycle and sessions: Pi and Claude children become `idle`, their
   session file exists, `subagent_message` respawns with resume args and the
   next report arrives; `subagent_wait` returns on the first child idle;
   `subagent_list` shows idle runs; a message to a `stopped` run fails.
3. Background tasks: fixture emits `result` with a live task, then
   `task_notification` and a second `result`; the run stays `running` until
   the second.
4. Telemetry and commands: entries appear in the root session in order;
   `/subagent-create` and `/subagent-stop` act on the runtime;
   `/subagent-show` renders the snapshot and the session path.
5. Docs and release: README, CHANGELOG 0.2.0, bundled profiles;
   `npm run check`, `nix flake check`.
