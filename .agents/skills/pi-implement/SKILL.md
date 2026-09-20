---
name: pi-implement
description: Implement and verify changes to the Pi sub-agent extension.
---

# Pi Implement

Follow [AGENTS.md](../../../AGENTS.md). Use this skill by default for implementation work.

## Ground the change

1. Read the installed Pi extension, SDK, and TUI documentation for the APIs in
   use.
2. Read the closest Pi example and the owning project files.
3. State the lifecycle transition, ownership rule, bounds, and failure behavior
   affected by the change.
4. Keep harness parsing behind its adapter and presentation state derived from
   the worker registry.

## Deliver

1. Add the smallest test that observes the protocol or lifecycle behavior.
2. Implement exact process control. Never search for or stop processes by name.
3. Keep stdout, stderr, event history, final output, and concurrency bounded.
4. Keep Claude agents as leaves through enforced tool configuration.
5. Keep normal execution independent of tmux.
6. Run the focused test, then `npm run check` when the change is complete.
