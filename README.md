# pi-subagents

A focused Pi extension for running observable, controllable sub-agents with Pi and Claude Code harnesses.

The parent Pi session will show a compact live view of each agent: harness,
model, thinking level, context use, recent tool activity, and state.

## Quickstart

```console
pi -e ./extensions/pi-subagents/index.ts
```

Call `subagent_list` to discover configured agent kinds. Start one with
`subagent`, using a distinct owner-scoped `id`, configured `name`, and initial
`prompt`. The root turn stops after starting children and wakes on each root
child completion with that child's final output. Nested delegation calls wait
without polling and return the child's final output. Root child questions open
a user input directly.
Nested questions return to the direct owner for an answer through
`subagent_message`. Profiles load from `~/.pi/agent/subagents.yaml` and trusted
project profiles load from `.pi/subagents.yaml`. Project profiles override user
profiles with the same name.

`examples/subagents.yaml` demonstrates `scout`, `pi-scout`, `research`,
`worker`, and `review`. Copy and adapt it for a project or user configuration.
Claude agents accept an optional `permissionMode` of `auto` or
`bypassPermissions`. It defaults to `bypassPermissions` when omitted. Use `auto`
for agents that must ask before acting. Pi agents reject the field.
Pi and Claude children use the same authenticated delegation protocol. Each
child can list and message only its configured delegate kinds and directly
owned runs. The original session retains all runs and their parent-child
relationships.
