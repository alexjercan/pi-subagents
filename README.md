# pi-subagents

A focused Pi extension for running observable, controllable sub-agents. It will support Pi and Claude Code harnesses without adding a separate desktop or web UI.

The parent Pi session will show a compact live view of each agent: harness, model, thinking level, context use, recent tool activity, and state. Agents will run as owned child processes and can be stopped by exact identity.

## Status

The repository scaffold and execution architecture are in place. Extension implementation is next. See [`docs/architecture.md`](docs/architecture.md).

## Development

```console
nix develop
npm install
npm run check
```

The future package will load in Pi as a local package during development:

```console
pi -e .
```
