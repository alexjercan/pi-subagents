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
`prompt`. Starts return immediately. A completed child wakes its owner with its
final output. Use `subagent_message` to steer a running child or answer a
pending question. Profiles load from `~/.pi/agent/subagents.yaml` and trusted
project profiles load from `.pi/subagents.yaml`. Project profiles override user
profiles with the same name.

`examples/subagents.yaml` demonstrates `scout`, `pi-scout`, `research`,
`worker`, and `review`. Copy and adapt it for a project or user configuration.
Pi and Claude children use the same authenticated delegation protocol. Each
child can list and message only its configured delegate kinds and directly
owned runs. The original session retains all runs and their parent-child
relationships.
