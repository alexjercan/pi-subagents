# Sub-agent architecture

## Scope

This project owns only delegation from a Pi session:

- named agent profiles;
- Pi and Claude Code harness adapters;
- process lifecycle and exact stop control;
- normalized activity events;
- compact live presentation inside the current Pi TUI; and
- bounded final results returned to the parent agent.

It does not own a desktop shell, remote conversation service, voice UI, or web application.

## Decision: extension-owned processes first

The first implementation will run each sub-agent as a direct child process of the Pi extension. Tmux is not the default executor.

A process is enough for the required control and observability:

- stdout and stderr provide the native structured event stream;
- an `AbortController` and recorded child identity provide cancellation;
- the extension can track start, activity, completion, failure, and exit directly;
- no terminal scraping or tmux polling is required; and
- the Pi TUI can update from normalized events as they arrive.

On Unix, each worker will get its own process group. The runtime will record the child PID and process-group ID, send `SIGTERM` to that exact owned group, wait for a bounded grace period, and then send `SIGKILL` to the same identity if needed. It will never search for a process by name or command line.

Session shutdown will stop session-owned workers. A later durable mode may explicitly detach jobs, but detached survival is not part of the first implementation.

## Why tmux is deferred

Tmux is useful when a worker must survive the parent process, preserve terminal scrollback, or allow a person to attach to the raw harness. It does not improve the extension's primary event stream. It adds a second lifecycle owner, stale-session recovery, identity fencing, terminal parsing, and socket policy.

If durable workers become a requirement, add tmux as an executor behind the same worker interface. Follow the useful Scufris2 rules:

- one recorded session per execution;
- random execution token plus logical job and generation metadata;
- `remain-on-exit` for post-mortem inspection;
- exact server-side identity checks before `kill-session`; and
- never kill the tmux server.

Do not place workers in panes of the user's current window. That changes the user's layout and couples worker lifecycle to an unrelated interactive session. A private server also gives little value unless jobs must outlive Pi. An optional detached session on the normal server is the least surprising future tmux mode.

## Harness boundary

All harnesses produce the same internal events:

```text
started
assistant.thinking
assistant.text
tool.started
tool.updated
tool.finished
usage.updated
completed
failed
```

Each event names the worker and carries a monotonic sequence number. Payloads are bounded before storage or display.

### Pi adapter

Run a separate Pi CLI process in JSON mode. This preserves context isolation and uses Pi's existing model catalogue, credentials, tools, and project context. Parse lifecycle, message, tool, and usage events from JSONL.

The adapter selects an explicit `provider/model`, thinking level, tool allowlist, working directory, and session policy. It will disable project extensions by default so a child cannot recursively load this extension. Agent profiles can opt into specific safe resources later.

Using the SDK in the parent process remains possible, but is not the first executor. A child process gives the Pi and Claude adapters the same failure boundary and stop semantics. It also prevents one sub-agent runtime failure from taking down the parent extension.

### Claude Code adapter

Run `claude --print --output-format stream-json` with an explicit model, effort, permission mode, and tool policy. Parse its stream into the same internal events.

Claude workers are leaves. Their profile must deny Claude's delegation and team tools. This restriction must be enforced in CLI tool configuration, not only stated in the prompt. The adapter owns the Claude process directly and does not rely on Pi to provide Claude models.

## Agent profiles

Profiles are data, not workflows. A profile chooses:

- harness: `pi` or `claude`;
- model;
- thinking or effort level;
- tool allowlist and deny list;
- system instructions;
- maximum runtime; and
- working-directory policy.

The spawn request chooses a profile and gives it one task. The runtime does not infer a chain such as implement-then-review from the profile list. The parent can start several explicit jobs or steer an existing persistent job in a later version.

Project-local profiles are trusted project input. They must only load after Pi marks the project trusted.

## Parent Pi integration

The extension will register these initial controls:

- `subagent_spawn`: start one named agent and return its ID immediately;
- `subagent_stop`: stop one owned agent by ID;
- `subagent_list`: return current and recently completed agents; and
- `/subagents`: open a detailed read-only view with stop controls.

The normal heads-up display will use a small widget above the editor, not a blocking overlay. Each row will show:

```text
state  name  harness/model  thinking  context used/limit  latest activity  elapsed
```

The widget is read-only and keeps the parent editor usable. A command can open an overlay for full recent activity and explicit stop actions. Tool renderers will show spawn and stop results in the transcript.

When a worker completes, the extension records a bounded result and injects one follow-up message into the parent session. Progress events update the widget but do not enter model context. Minimal thinking display means a short latest-thinking summary or activity label, never an unbounded reasoning transcript.

## State model

A worker has one owner and one terminal state:

```text
starting -> running -> completed
                    -> failed
                    -> stopping -> stopped
```

The registry records:

- generated worker ID;
- profile snapshot;
- task and working directory;
- start and finish times;
- process and process-group IDs;
- latest normalized activity;
- recent bounded event ring;
- usage and context-window values; and
- bounded final output or failure detail.

The process manager is the source of truth. UI components render snapshots and never own worker lifecycle.

## Lessons retained from Scufris2

Useful ideas to keep:

- separate logical work from an execution attempt;
- use adapters for Pi and Claude;
- pin model and thinking configuration per execution;
- record exact ownership before allowing stop;
- report progress through structured events instead of terminal text;
- keep completed evidence bounded but inspectable; and
- make cleanup idempotent.

Ideas intentionally omitted:

- the desktop and mobile surfaces;
- conversation sockets and leases;
- voice, widgets, briefings, and general assistant identity;
- mandatory tmux execution;
- Sprout and landing policy in the runtime; and
- a broad durable job service before durability is required.

## Implementation sequence

1. Define and test profile parsing and normalized event types.
2. Implement exact process ownership, shutdown, timeout, and stop tests with a fixture process.
3. Implement the Pi JSON adapter.
4. Add the Pi tools, registry, and compact widget.
5. Implement the Claude stream-json adapter and leaf tool policy.
6. Add the detailed `/subagents` view and concurrency limits.
7. Evaluate an optional tmux executor only after direct-process use exposes a concrete durability need.
