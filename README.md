# pi-subagents

A Pi extension that runs observable, controllable sub-agents on the Pi and
Claude Code harnesses. The root Pi session shows a live tree of every run:
harness, model, thinking level, elapsed time, usage, and recent activity.

## Quickstart

```console
pi -e ./extensions/pi-subagents/index.ts
```

Profiles load from `~/.pi/agent/subagents.yaml`. Trusted projects also load
`.pi/subagents.yaml`, and a project profile replaces a user profile with the
same name. `examples/subagents.yaml` defines `scout`, `pi-scout`, `research`,
`worker`, and `review`.

## Tools

The root Pi session, Pi children, and Claude children see one tool contract
with bare names and identical schemas.

- `subagent_create(id, name, prompt)` starts a direct child from a configured
  kind and returns at once. The `id` is unique among the caller's direct
  children.
- `subagent_message(id, message)` answers a waiting child's question, steers a
  running child, or resumes an idle child with a new prompt.
- `subagent_wait(ids?)` blocks without a time limit until a direct child in
  `ids` (default all) becomes idle, waiting, stopped, or failed, then returns
  those notices. Progress keepalives run every 30 seconds.
- `subagent_list()` lists the kinds the caller may create and its direct
  children that are running, waiting, or idle, with the report of each idle
  child.
- `subagent_stop(id)` stops a live or idle direct child and its subtree.
- `subagent_ask(prompt)` is available to children only. It asks the owner a
  question and blocks until the owner answers through `subagent_message`.

Reports and questions reach the owner when the owner ends its turn or calls
`subagent_wait`. A child must never sleep or poll; it waits with
`subagent_wait`, or it asks its owner with `subagent_ask` or by ending its turn
with the question. A notice that `subagent_wait` returned is not delivered
again at turn end. The root session has no owner, so `subagent_ask` is not
registered there; a root child's question wakes the root model instead.

## Statuses

- `running`: the harness process is live. It works on a turn or waits for its
  own children or background tasks.
- `waiting`: the child called `subagent_ask` and blocks until its owner
  answers.
- `idle`: the turn settled with no live children, no live background tasks,
  and no pending notices. The process exited and the session is kept.
- `stopped`: `subagent_stop` ended the run, or its owner was stopped.
- `failed`: the harness exited abnormally, a turn ended with an error, or a
  notice could not be delivered.

An idle run keeps its run id, grant, and session. `subagent_message` on an idle
run respawns the harness with its session: Claude with `--resume <runId>`, Pi
with `--session-id <runId> --session-dir <dir>`. The next report arrives the
same way as the first. Messages to stopped and failed runs are rejected.

## Sessions

Every run has a session that survives idle periods and can be inspected:

- Claude: `~/.claude/projects/<encoded cwd>/<runId>.jsonl`, where the encoded
  cwd replaces every character outside `A-Za-z0-9` with `-`.
- Pi: `~/.pi/agent/subagents/<encoded cwd>/`, where the encoded cwd replaces
  every character outside `A-Za-z0-9._-` with `-`. The session file name ends
  with `_<runId>.jsonl`.

`/subagent-show` prints the session path of a root run.

## Transports

Claude children receive the tools as an SDK MCP server named `pi_subagents`
over the child's own stdio control frames. The runtime sends an `initialize`
control request before the first prompt, answers `mcp_message` requests through
an in-memory MCP transport, and sets `CLAUDE_AGENT_SDK_MCP_NO_PREFIX=1` so the
child sees bare tool names. Claude children run with `--strict-mcp-config` and
disallow `Task`, `Agent`, and `AskUserQuestion`. No HTTP server, `--mcp-config`,
or Bearer grant is involved for Claude.

Pi children load `bridge.ts` as an extension and call the tools over the
runtime's HTTP MCP host with a per-run Bearer grant. Every Pi child carries
`PI_SUBAGENTS_RUN_ID`, and the root extension skips its runtime, tools, and
commands when that variable is set.

Background tasks stay enabled for Claude children. A `result` settles the turn
only when the live set reported by `background_tasks_changed` is empty, so a
child that started a background build keeps running until the task
notification and the following `result`. The runtime sets
`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`.

## Telemetry

The runtime appends a `pi-subagents` entry to the root session for every
lifecycle step: `create`, `resume`, `message`, `ask`, `answer`, `wait`, `stop`,
`idle`, and `failed`. Each entry carries the run id, child id, owner run id,
agent, harness, model, a copy of the usage at that moment, the pid, the session
path, and the prompt, message, question, notices, report, or error as `text`.
Entries are stored in the session file and excluded from model context.

## Commands

- `/subagent-list` prints one line per root child: status, id, agent, elapsed
  time, usage, and the first report line of an idle run.
- `/subagent-show <id>` shows the snapshot, pid, session path, usage, question,
  recent events, and full report in a scrollable view.
- `/subagent-create <name> <id> <prompt>` creates a root run. Its reports wake
  the root model like model-created runs.
- `/subagent-message <id> <text>` answers, steers, or resumes a root run.
- `/subagent-stop <id>` stops a root run and its subtree.

When the id is missing and a UI is available, the command opens a selector over
the running, waiting, and idle root children. In RPC mode `/subagent-show`
prints the details as a notification.

## Configuration

```yaml
agents:
  worker:
    description: Implement a task.
    harness: claude
    model: opus
    thinking: high
    permissionMode: bypassPermissions
    tools: [read, grep, find, ls, bash, edit, write]
    delegates: [scout, review]
    system: |
      Implement the requested change.
```

- `description` (required) is shown to owners in `subagent_list`.
- `harness` (required) is `pi` or `claude`.
- `model` (required) is the harness model id.
- `thinking` (required) is `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  or `max` for Pi, and `low`, `medium`, `high`, `xhigh`, or `max` for Claude.
- `permissionMode` (Claude only) is `auto` or `bypassPermissions`. It defaults
  to `bypassPermissions`. Pi profiles reject the field.
- `tools` (optional) is a subset of `read`, `grep`, `find`, `ls`, `bash`,
  `edit`, `write`, `web_search`, and `web_fetch`. An omitted list keeps the
  harness default tool set.
- `delegates` (optional) names the profiles this agent may create. Every name
  must exist.
- `system` (required) is appended to the harness system prompt.

A profile without `delegates` gets no subagent tools at all: no MCP server for
Claude, no bridge for Pi. Such a leaf asks its owner by ending its turn with the
question, and the owner resumes it with `subagent_message`. A profile with
`delegates` gets the full contract, its `system` text is followed by the
delegation guidance, and it may create only the named kinds.

The `system` text is passed as `--append-system-prompt` on both harnesses, so
the harness keeps its own base prompt and tool instructions. Write the profile
as role and procedure guidance, not as a replacement system prompt. Delegating
profiles should tell the agent to call `subagent_list` before delegation and to
ask one focused decision through `subagent_ask` when an interface, name,
default, ownership, or error policy is unresolved.

## Development

```console
npm install
npm run check
nix flake check
```
