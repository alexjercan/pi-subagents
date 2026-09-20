# pi-subagents

A focused Pi extension for running observable, controllable sub-agents with Pi and Claude Code harnesses.

The parent Pi session will show a compact live view of each agent: harness,
model, thinking level, context use, recent tool activity, and state.

## Quickstart

```console
pi -e .
```

Use the `subagent` tool with an agent name and task. Profiles load from
`~/.pi/agent/subagents.yaml` and trusted project profiles load from
`.pi/subagents.yaml`. Project profiles override user profiles with the same
name.

The repository configuration defines `scout`, `pi-scout`, `research`,
`worker`, and `review`. The Claude worker can call its delegated roles through an authenticated
MCP server owned by the original Pi session. The original session retains all
runs and their parent-child relationships.
