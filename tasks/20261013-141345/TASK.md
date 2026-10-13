# Harden subagent communication, errors, and process lifecycle

- STATUS: CLOSED
- PRIORITY: 1
- TAGS: bug, runtime, mcp

Source: review of the 2026-10-09..11 the-specimen-bevy sessions (pi-subagents
v0.1.9 installed) and of the v0.1.10 code. Goal: nothing can crash the root
Pi session, owner/child communication never times out or deadlocks, errors
reach the owner as errors, and no process is left orphaned or hanging.

Decisions (approved 2026-10-13):

- (8) Remind the owner on every turn settle while a direct child waits.
- SIGKILL grace after SIGTERM: 5 s.
- MCP keepalive progress interval: 30 s.
- (9) Keep `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` (wait forever; background
  tasks are disabled).
- (10) Event retention and per-event copying: out of scope.

## (1) Owner receives only the last turn text

- Issue: `harness.ts:102` overwrites `finalText` on every assistant/result
  record. A worker that reports, ends its turn, and wakes for late child
  reports delivers only the follow-up ("Nothing changes."). Seen in 3 of 5
  completed worker-opus runs (steam-opus-1, halloween-implementation-opus,
  layout-fixes-opus).
- Fix: keep the final text of each settled turn and deliver all turn reports
  to the owner, not only the last turn.

## (2) Errors that crash the root Pi session

- Issue: no `error` listener on `child.stdin` (`process.ts:94-104`). A write
  to a dead child (owner delivery, `subagent_message`) raises an uncaught
  EPIPE and exits the root Pi process without `session_shutdown`. Reproduced.
- Issue: child process `error` listener is `once` (`process.ts:75`); a second
  `error` event (for example a failed kill) is uncaught.
- Fix: record stdin errors so `send` rejects; use a persistent `error`
  listener; catch ESRCH from process-group signals.

## (3) Stopped runs report failed or completed instead of cancelled

- Issue: `settled` is set once and never reset (`harness.ts:104-106`), and
  `runtime.ts:377` cancels only when `!result.settled`. An owner idle while it
  waits for children has settled, so a stop gives `failed` (Pi exits 143) or
  `completed`. Reproduced.
- Issue: `stopTree` runs without marking runs as stopping when a parent
  finishes and on `close` (`runtime.ts:416-418`, `runtime.ts:555-563`), so
  killed children report `completed`. Reproduced.
- Fix: replace `settled` with a result field that is true only when the
  harness closed its own input after its final turn. A run that was stopped
  and did not finish is `cancelled`. `stopTree` marks every run it stops.

## (5) Ask, stop, and replies must wait without a time limit

- Issue: the MCP server uses `enableJsonResponse: true` (`mcp.ts:277`) and
  buffers the response (`mcp.ts:87-94`), so no headers are sent until the
  tool returns.
  - Claude children (2.1.280): the HTTP MCP POST aborts after 60 s without
    headers (per-server `timeout` or `MCP_TOOL_TIMEOUT`, minimum 60000), plus
    a 300 s tool idle timeout and a wall-clock limit, all clamped to
    2147483647 ms.
  - Pi children: `bridge.ts:39-43` calls `callTool` with the MCP SDK default
    60000 ms request timeout.
- Fix:
  - `mcp.ts`: SSE responses (no JSON response mode), stream the response
    body, and send a progress notification every 30 s while `subagent_ask`
    or `subagent_stop` is pending.
  - `bridge.ts`: `callTool` with `onprogress` and
    `resetTimeoutOnProgress: true`, no total timeout.
  - `harnesses/claude.ts`: set `"timeout": 2147483647` on the
    `pi_subagents` server in `--mcp-config` (the Claude Code maximum,
    about 24.8 days).

## (6) Errors must reach the owner as errors

- Issue: Claude `result` with `is_error` or a non-`success` subtype
  (max turns, API 529) is reported `completed` (`harnesses/claude.ts:141-158`).
  Fix: `failed` with `errors[]` or `result` as the message.
- Issue: Pi `response` with `success: false` for `prompt`/`steer` (for example
  expired auth) is ignored and the child hangs (`harnesses/pi.ts:69-102`).
  Fix: `failed` with the response `error`, and stop the process.
- Issue: a Pi final assistant message with `stopReason: "error"` is reported
  `completed`. Fix: `failed` with `errorMessage`.
- Issue: exit before settling gives "Harness exited before reporting
  completion" without stderr or exit code (`harness.ts:131-132`). Fix: include
  both.
- Issue: any signal death is `cancelled` (`runtime.ts:380-382`), including
  OOM or external SIGKILL. Fix: `cancelled` only for runs this runtime
  stopped; otherwise `failed` with the signal name.

## (7) Kill the whole tree; no orphaned or hanging processes

- Issue: stop sends one SIGTERM to the harness PID only, without a process
  group or escalation (`process.ts:108-110`). Grandchildren (cargo, bash)
  survive, and `stop()`/`close()` can wait forever (`runtime.ts:274`,
  `runtime.ts:561`).
- Fix: spawn each harness in its own process group (`detached: true`); stop
  sends SIGTERM to the group, then SIGKILL after 5 s.
- Fix: on root process `exit` (including an uncaught error), SIGKILL every
  live harness group synchronously.
- Issue: Pi `extension_ui_request` dialogs block a Pi child forever
  (`harnesses/pi.ts` ignores them). Fix: answer dialog requests with
  `{"type":"extension_ui_response","id":...,"cancelled":true}`.
- Limit: a SIGKILL of the root Pi process cannot run the exit handler.

## (8) Unanswered question deadlocks owner and child

- Issue: a child question is queued to its owner once (`runtime.ts:339-343`).
  If the owner ends its turn without `subagent_message`, the owner stays idle
  because a child is active (`runtime.ts:216-221`) and the child waits
  forever. steam-opus-1 ended with its question as final text.
- Fix: in `turnSettled`, when a direct child still waits on a question,
  deliver the question again to the owner on every settle.

## Proof

- Focused unit tests for each named failure above (fake harness processes).
- `npm run check` and `nix flake check`.
- Manual: a Pi bridge client and a Claude child each wait more than 5 minutes
  on `subagent_ask` and receive the answer.

## Implementation decisions (2026-10-13, confirmed)

- (1) `HarnessResult.finalText` holds the final text of every settled turn,
  joined by a blank line.
- (3) `HarnessResult.settled` is replaced by `finished`. "Exited before
  reporting completion" applies only when the harness exits during a turn.
- (6) A turn error stops the harness and fails the run. The failure message
  carries the final text of earlier settled turns. Pi errors count only
  when the last assistant message of the settled turn has `stopReason: "error"`,
  so an auto-retry that recovers completes.
- (6) Pi input is always `prompt` with `streamingBehavior: "steer"`. Pi starts
  a run when idle and queues a steer when busy. The adapter has one `prompt`
  method instead of `initial` and `steer`.
- (7) When a harness process exits, the runtime sends SIGKILL to the rest of
  its process group, so that no orphan holds the output pipes open.
- (7) The root `exit` handler is registered by `process.ts` while any harness
  group is live, not once per runtime.
- (7) Claude Code Bash tool shells and Pi bash tool shells run in their own
  process groups (`detached: true`). The harness group kill does not reach
  them. Each harness kills them on SIGTERM; SIGKILL leaves them orphaned.
