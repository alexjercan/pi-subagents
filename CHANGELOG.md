# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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

[Unreleased]: https://github.com/alexjercan/pi-subagents/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/alexjercan/pi-subagents/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/alexjercan/pi-subagents/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/alexjercan/pi-subagents/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/alexjercan/pi-subagents/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/alexjercan/pi-subagents/releases/tag/v0.1.0
