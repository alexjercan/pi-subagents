# AGENTS.md

Global `~/AGENTS.md` applies. This file defines project-specific instructions.

## Project

- `pi-subagents` is only a sub-agent runtime and Pi extension.

## Workflow

- Inspect installed Pi documentation and examples before changing Pi APIs.
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
