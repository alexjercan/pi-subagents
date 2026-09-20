# AGENTS.md

`~/AGENTS.md` applies.

## Project

- `pi-subagents` is a sub-agent runtime and Pi extension.

## Work

- Use Pair by default. Use `pi-implement` for approved implementation work.
- Read installed Pi documentation, examples, owning code, callers, and closest checks before proposing changes.
- State the end state, what dies, what may break, and what must fail loudly.
- Map one feature slice: owner, entry point, inputs, state, outputs, lifecycle, callers, and proof.
- Stop for interfaces, names, defaults, precedence, ownership, lifecycle, and failure policy.
- Continue approved mechanical work. Do not ask only whether to continue.
- Do not edit while answering a question.
- At stops use `Delta`, `Verified`, and `Next`. Put one decision question on its own final line.
- Work on `master`. Use Sprout only when the user requests an isolated worktree.
- Stage explicit paths. Never leave the index staged across tool calls.

## Implementation gate

Before code edits, show exact paths and lines, existing types and functions, proposed types, fields, functions, and signatures, a compact before and after caller/callee graph, and the behavior or failure the proof will observe. Wait for approval before adding a type, function, or test. Continue an approved design directly.

## Change policy

- Replace obsolete internal interfaces. Delete old paths, adapters, aliases, and tests.
- Do not add speculative requirements, compatibility, abstractions, fallbacks, configuration, or dependencies.
- Change the owning interface first. Use type errors and searches to update every caller.
- Put Pi APIs in `peerDependencies`. Put runtime libraries in `dependencies`.

## Comments

Do not write comments in code. Use clear names, focused functions, types, and tests instead. Delete code comments encountered in changed code. `nix flake check` enforces this for TypeScript and JavaScript source.

## Evidence

- Report Claim, Evidence (`path:line`), Change, Blast radius, and Verification. Label unverified claims.
- Reproduce defects before fixing them and preserve useful before and after evidence.
- Add tests only for named stable behavior, an invariant, or a reproduced failure.
- Prefer focused unit tests for protocol normalization and process lifecycle.
- Run the cheapest affected check during work. Run `npm run check` before completion.

## Commands

Run commands from the repository root, directly or through the Nix shell:

```bash
nix develop
npm install
npm run check
nix flake check
```
