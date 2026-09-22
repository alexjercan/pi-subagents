import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadAgentProfiles } from "../extensions/pi-subagents/config.ts";

async function configuration(
  user: string | undefined,
  project: string | undefined,
) {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(cwd, ".pi"), { recursive: true });
  if (user !== undefined)
    await writeFile(join(agentDir, "subagents.yaml"), user);
  if (project !== undefined)
    await writeFile(join(cwd, ".pi", "subagents.yaml"), project);
  return {
    agentDir,
    cwd,
    close: () => rm(root, { recursive: true, force: true }),
  };
}

test("Trusted project agents override user agents by name", async () => {
  const files = await configuration(
    `agents:
  scout:
    description: Read the project.
    harness: pi
    model: openai/gpt-test
    thinking: medium
    tools: [read, grep]
    system: |
      Inspect the requested code.
      Return evidence.
  shared:
    description: User definition.
    harness: pi
    model: openai/gpt-user
    thinking: low
    system: User prompt.
`,
    `agents:
  shared:
    description: Project definition.
    harness: claude
    model: sonnet
    thinking: high
    tools: []
    delegates: [reviewer]
    system: Project prompt.
  reviewer:
    description: Review the project.
    harness: claude
    model: opus
    thinking: xhigh
    permissionMode: auto
    system: Review the requested change.
`,
  );
  try {
    const loaded = await loadAgentProfiles({
      cwd: files.cwd,
      agentDir: files.agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(
      loaded.map((profile) => profile.name),
      ["scout", "shared", "reviewer"],
    );
    assert.equal(
      loaded[0]?.system,
      "Inspect the requested code.\nReturn evidence.\n",
    );
    assert.deepEqual(loaded[0]?.tools, ["read", "grep"]);
    assert.deepEqual(loaded[1], {
      name: "shared",
      description: "Project definition.",
      config: {
        harness: "claude",
        model: "sonnet",
        thinking: "high",
        permissionMode: "bypassPermissions",
      },
      system: "Project prompt.",
      tools: [],
      delegates: ["reviewer"],
      source: "project",
      path: join(files.cwd, ".pi", "subagents.yaml"),
    });
    assert.deepEqual(loaded[2]?.config, {
      harness: "claude",
      model: "opus",
      thinking: "xhigh",
      permissionMode: "auto",
    });
    assert.equal(loaded[2]?.source, "project");
    assert.deepEqual(loaded[0]?.delegates, []);
  } finally {
    await files.close();
  }
});

test("Untrusted project configuration is not read", async () => {
  const files = await configuration(
    `agents:
  scout:
    description: Read the project.
    harness: pi
    model: openai/gpt-test
    thinking: medium
    system: Inspect the requested code.
`,
    "invalid: [",
  );
  try {
    const loaded = await loadAgentProfiles({
      cwd: files.cwd,
      agentDir: files.agentDir,
      projectTrusted: false,
    });
    assert.deepEqual(
      loaded.map((profile) => profile.name),
      ["scout"],
    );
    assert.equal(loaded[0]?.source, "user");
  } finally {
    await files.close();
  }
});

test("Example profiles define configured agent roles", async () => {
  const source = await readFile(
    join(process.cwd(), "examples", "subagents.yaml"),
    "utf8",
  );
  const files = await configuration(undefined, source);
  try {
    const loaded = await loadAgentProfiles({
      cwd: files.cwd,
      agentDir: files.agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(
      loaded.map((profile) => ({
        name: profile.name,
        model: profile.config.model,
        thinking: profile.config.thinking,
        tools: profile.tools,
        delegates: profile.delegates,
      })),
      [
        {
          name: "scout",
          model: "haiku",
          thinking: "medium",
          tools: ["read", "ls", "grep", "find"],
          delegates: [],
        },
        {
          name: "pi-scout",
          model: "openai-codex/gpt-5.6-luna",
          thinking: "medium",
          tools: ["read", "ls", "grep", "find"],
          delegates: [],
        },
        {
          name: "research",
          model: "haiku",
          thinking: "medium",
          tools: ["web_search", "web_fetch"],
          delegates: [],
        },
        {
          name: "worker",
          model: "opus",
          thinking: "high",
          tools: undefined,
          delegates: ["scout", "research", "review"],
        },
        {
          name: "review",
          model: "sonnet",
          thinking: "medium",
          tools: ["read", "ls", "grep", "find", "bash"],
          delegates: [],
        },
      ],
    );
  } finally {
    await files.close();
  }
});

test("Missing configuration files produce no agents", async () => {
  const files = await configuration(undefined, undefined);
  try {
    assert.deepEqual(
      await loadAgentProfiles({
        cwd: files.cwd,
        agentDir: files.agentDir,
        projectTrusted: true,
      }),
      [],
    );
  } finally {
    await files.close();
  }
});

test("Invalid agent configuration fails the complete source file", async () => {
  const invalidSources = [
    {
      source: `agents:
  scout:
    description: Read the project.
    harness: pi
    model: openai/gpt-test
    thinking: medium
    system: Inspect.
    extra: rejected
`,
      error: /unknown field extra/,
    },
    {
      source: `agents:
  scout:
    description: Read the project.
    harness: claude
    model: sonnet
    thinking: minimal
    system: Inspect.
`,
      error: /thinking is not supported by claude/,
    },
    {
      source: `agents:
  scout:
    description: Read the project.
    harness: claude
    model: sonnet
    thinking: high
    permissionMode: acceptEdits
    system: Inspect.
`,
      error: /permissionMode must be auto or bypassPermissions/,
    },
    {
      source: `agents:
  scout:
    description: Read the project.
    harness: pi
    model: openai/gpt-test
    thinking: medium
    permissionMode: auto
    system: Inspect.
`,
      error: /permissionMode requires the claude harness/,
    },
    {
      source: `agents:
  scout:
    description: Read the project.
    harness: pi
    model: openai/gpt-test
    thinking: low
    tools: [unknown]
    system: Inspect.
`,
      error: /unknown tool unknown/,
    },
    {
      source: `agents:
  scout:
    description: First.
    harness: pi
    model: openai/gpt-test
    thinking: low
    system: First.
  scout:
    description: Second.
    harness: pi
    model: openai/gpt-test
    thinking: low
    system: Second.
`,
      error: /Map keys must be unique/,
    },
    {
      source: `agents:
  worker:
    description: Implement.
    harness: pi
    model: openai/gpt-test
    thinking: medium
    delegates: [worker]
    system: Implement.
`,
      error: /delegates requires the claude harness/,
    },
    {
      source: `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [missing]
    system: Implement.
`,
      error: /delegates to unknown agent missing/,
    },
    {
      source: `agents:
  first:
    description: First.
    harness: claude
    model: opus
    thinking: medium
    delegates: [second]
    system: First.
  second:
    description: Second.
    harness: claude
    model: opus
    thinking: medium
    delegates: [first]
    system: Second.
`,
      error: /delegation cycle/,
    },
  ];

  for (const invalid of invalidSources) {
    const files = await configuration(invalid.source, undefined);
    try {
      await assert.rejects(
        loadAgentProfiles({
          cwd: files.cwd,
          agentDir: files.agentDir,
          projectTrusted: true,
        }),
        invalid.error,
      );
    } finally {
      await files.close();
    }
  }
});
