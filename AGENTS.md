# AGENTS.md

Global `~/AGENTS.md` applies. This file defines project-specific instructions.

## Project

- `pi-subagents` is only a sub-agent runtime and Pi extension.
- Do not add a desktop app, web UI, voice interface, or general assistant shell.
- Keep the parent Pi session responsive while delegated agents run.
- Treat Claude CLI agents as leaves. They must not delegate more agents.

## Architecture

- Keep Pi lifecycle, tools, commands, and TUI rendering in `extensions/pi-subagents/`.
- Keep harness-specific protocol parsing behind adapters.
- Keep process ownership and state independent from presentation.
- Use exact process IDs or recorded process-group IDs for control. Never use broad process matching.
- Do not require tmux for normal execution. Any future tmux backend must be optional.
- Keep agent definitions as data. Do not hard-code task routing into the runtime.
- Bound captured output, event sizes, concurrency, and retained history.
- Start long-lived resources from `session_start` or an explicit action, never from the extension factory.
- Stop owned resources idempotently during `session_shutdown`.

## Workflow

- Inspect installed Pi documentation and examples before changing Pi APIs.
- Read `docs/architecture.md` before changing execution ownership or lifecycle.
- Add files with their first tested behavior. Do not add empty placeholders.
- Use strict TypeScript and Prettier.
- Put Pi APIs in `peerDependencies`. Put runtime libraries in `dependencies`.
- Prefer focused unit tests for protocol normalization and process lifecycle.
- Run the cheapest relevant check during work. Run `npm run check` before completion.

## Commands

Run commands from the repository root, directly or through the Nix shell:

```bash
nix develop
npm install
npm run check
nix flake check
```

## Comment policy

Use comments only for a concrete constraint, safety rule, or non-obvious reason.
Do not add narrative headings, commented-out code, or comments that restate the
implementation.
