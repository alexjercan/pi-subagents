# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

## [0.2.0] - 2026-11-10

### Added

- Add `subagent_create`, `subagent_message`, `subagent_wait`, `subagent_list`, `subagent_stop`, and `subagent_ask` as one tool contract defined in `tools.ts` and served to the root Pi session, Pi children over the HTTP bridge, and Claude children over SDK MCP on their own stdio.
- Add `subagent_wait`, which blocks without a time limit until a directly owned run becomes idle, waiting, stopped, or failed and returns its notices with progress keepalives every 30 seconds.
- Add the `idle` status: a settled turn with no live children, background tasks, or pending notices ends the process, keeps the session, and reports to the owner; `subagent_message` resumes the run with Claude `--resume` or the Pi session flags.
- Add Pi child sessions under `~/.pi/agent/subagents/<encoded cwd>/` and the session path to every run snapshot.
- Add `SubagentLogEntry` telemetry for create, resume, message, ask, answer, wait, stop, idle, and failed, appended to the root session through `pi.appendEntry` with usage, pid, and session path.
- Add the `/subagent-list`, `/subagent-show`, `/subagent-create`, `/subagent-message`, and `/subagent-stop` commands; a missing id opens a selector, and user-created runs report to the root model like model-created runs.
- Add the ask wording to the bundled delegating example profiles.

### Changed

- Launch Claude children with an SDK `initialize` control request, answer `mcp_message` frames through an in-memory MCP transport, and expose bare tool names with `CLAUDE_AGENT_SDK_MCP_NO_PREFIX`.
- Keep Claude children alive while their background tasks run: a `result` settles the turn only when the live task set from `background_tasks_changed` is empty.
- Give profiles without `delegates` no subagent tools at all; a leaf asks by ending its turn and its owner resumes it.
- Report the last settled turn instead of joining every turn, and deliver each notice to the owner once.
- Tell owners in tool descriptions and the delegation guidance that reports arrive on turn end or `subagent_wait` and that sleeping and polling are forbidden.
- Mark every Pi child with `PI_SUBAGENTS_RUN_ID` so the root extension stays out of leaf children as well as bridged ones.

### Removed

- Remove the `subagent` tool, the `completed` and `cancelled` statuses, the `Agent exited before receiving child updates` failure, and the joined `reports[]` result.
- Remove `--mcp-config`, `--allowedTools mcp__*`, Bearer grants, and the HTTP MCP path for Claude children.
- Remove `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` and `--no-session` for Pi children.

## [0.1.11] - 2026-10-13

### Changed

- Report the final text of every settled turn to the owner, including when a later turn fails, instead of only the last turn.
- Remind an owner of each unanswered child question every time it ends a turn while the child still waits.
- Run each harness in its own process group; stop sends SIGTERM to the group and SIGKILL after 5 seconds, and root exit kills every live group.

### Fixed

- Reject writes to a closed harness input instead of crashing the parent Pi session with an uncaught EPIPE.
- Report stopped owners that wait for children, and children stopped with their owner, as cancelled.
- Wait without a time limit for `subagent_ask` and `subagent_stop` over MCP by streaming responses with progress keepalives and raising the Claude MCP server timeout.
- Report Claude result errors, rejected Pi prompts, and Pi turns that end with an error as failed with their messages.
- Include the exit code and stderr when a harness exits during a turn, and report signals the runtime did not send as failures.
- Answer Pi dialog requests as cancelled so children cannot block on them.

## [0.1.10] - 2026-10-01

### Changed

- Save new Claude child sessions under their subagent run IDs for inspection while keeping completion reports in the parent Pi session.

## [0.1.9] - 2026-09-28

### Added

- Add project agent profiles for a Pi GPT-6 Sol worker and Luna scout alongside the Claude Opus worker and Haiku scout.

### Fixed

- Resume idle Pi workers with a prompt when a delegated child finishes, while retaining steering for active turns.

## [0.1.8] - 2026-09-28

### Changed

- Return promptly from nested delegation calls and push child completions and questions to their direct owner.

### Fixed

- Avoid persisting full subagent event histories in tool results, which could make Pi sessions too large to resume.

## [0.1.7] - 2026-09-26

### Changed

- Update the bundled Pi scout example to GPT-6 Luna.

### Fixed

- Allow Pi harness agents to delegate to configured child agents.

## [0.1.6] - 2026-09-24

### Added

- Add `subagent_stop` for direct owners to cancel a running or waiting subagent and its active descendants.

## [0.1.5] - 2026-09-23

### Changed

- Wake the root orchestrator for each top-level subagent completion instead of waiting for all active root subagents.

## [0.1.4] - 2026-09-22

### Added

- Add configurable `auto` and `bypassPermissions` modes for Claude agents.

### Changed

- Use `cross-spawn` to launch harness processes so command shims work on Windows.
- Use Qwen 3.5 9B for the bundled basic agent profile.

## [0.1.3] - 2026-09-21

### Changed

- Show per-agent usage on the agent row and collapse completed, failed, and cancelled subagents to one row in the live tree.
- Limit `subagent_list` results to directly owned subagents that are running or waiting.
- Route subagent questions through their direct owners and reserve `subagent_ask` for delegated agents.
- Wake the orchestrator for top-level subagent questions instead of opening a direct user input prompt.

### Fixed

- Reject answers to subagents that exited while waiting instead of leaving a stranded input prompt.

## [0.1.2] - 2026-09-20

### Fixed

- Preserve cumulative session token and cost totals while displaying only active subagent trees.
- Count all terminal subagent states as completed in the live tree summary.

## [0.1.1] - 2026-09-20

### Added

- Add a basic scout agent profile.

### Fixed

- Prevent subagent extension conflicts in delegated Pi processes.

## [0.1.0] - 2026-09-20

### Added

- Add configurable Pi and Claude subagent harnesses.
- Add layered YAML agent configuration and delegated agent profiles.
- Add asynchronous nested subagent control and direct-owner messaging.
- Add the live subagent tree with usage and activity reporting.

[Unreleased]: https://github.com/alexjercan/pi-subagents/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/alexjercan/pi-subagents/compare/v0.1.11...v0.2.0
[0.1.11]: https://github.com/alexjercan/pi-subagents/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/alexjercan/pi-subagents/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/alexjercan/pi-subagents/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/alexjercan/pi-subagents/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/alexjercan/pi-subagents/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/alexjercan/pi-subagents/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/alexjercan/pi-subagents/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/alexjercan/pi-subagents/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/alexjercan/pi-subagents/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alexjercan/pi-subagents/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexjercan/pi-subagents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexjercan/pi-subagents/releases/tag/v0.1.0
