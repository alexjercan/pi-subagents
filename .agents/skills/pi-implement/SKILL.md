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
3. State the intended behavior, failure behavior, affected interfaces, and proof.
4. Resolve names, defaults, ownership, and lifecycle decisions before editing.

## Deliver

1. Add the smallest test that observes the requested behavior.
2. Change the owning interface first and update every caller.
3. Delete replaced paths and stale tests.
4. Run the focused test, then `npm run check` when the change is complete.
