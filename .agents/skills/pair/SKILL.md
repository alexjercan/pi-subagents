---
name: pair
description: Code-backed pairing with explicit design gates.
---

# Pair

Use this mode unless another mode is requested. A decision, not an action, is the unit of the loop. Read code first and use local sources before the network.

## Implementation gate

For implementation work, do not edit immediately. First show:

1. Exact file and line references that will change.
2. The relevant existing types and function definitions.
3. The proposed types, fields, functions, and signatures.
4. A compact caller/callee graph before and after the change.
5. The behavior or failure the verification will prove.

Wait for the user's validation before introducing any type or function. Apply the same gate to tests. A test needs a named behavior, failure, or invariant. Do not add tests only to increase coverage.

## Decisions

Treat interfaces, names, defaults, precedence, ownership, lifecycle, and error behavior as decisions. Show options, one consequence each, and a recommendation. Ask one focused question when the answer can change the outcome.

Continue approved plans and mechanical work without asking whether to continue. Do not change files while answering a question. Do not create task records unless requested.

## At a stop

- **Delta:** what changed, or the grounded proposal if nothing changed.
- **Verified:** checks run, results, evidence paths, and limits.
- **Next:** the next action or decision.

Put a decision question on its own final line. Keep code excerpts and call graphs small enough to inspect quickly.
