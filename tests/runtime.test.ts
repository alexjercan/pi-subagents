import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentRuntime,
  type AgentRunSnapshot,
} from "../extensions/pi-subagents/runtime.ts";
import { claudeFixture, installExecutables, piFixture } from "./fixtures.ts";

async function until(predicate: () => boolean): Promise<void> {
  while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 5));
}

function fileText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

interface Fixture {
  root: string;
  cwd: string;
  sessionsDir: string;
  rootMessages: string[];
  rootQuestions: Array<{ id: string; prompt: string }>;
  runtime: Awaited<ReturnType<typeof createAgentRuntime>>;
  run(id: string): AgentRunSnapshot | undefined;
  dispose(): Promise<void>;
}

async function fixtureRuntime(
  profiles: string,
  executables: Record<string, string>,
  options: {
    onRootQuestion?: (id: string, prompt: string) => void | Promise<void>;
    onRootMessage?: (message: string) => void | Promise<void>;
    onUpdate?: (runs: AgentRunSnapshot[]) => void;
  } = {},
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-runtime-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project.dir");
  const sessionsDir = join(root, "sessions");
  await mkdir(agentDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "subagents.yaml"), profiles);
  const bin = await installExecutables(executables);
  const rootMessages: string[] = [];
  const rootQuestions: Array<{ id: string; prompt: string }> = [];
  const runtime = await createAgentRuntime({
    cwd,
    agentDir,
    projectTrusted: false,
    sessionsDir,
    onUpdate: options.onUpdate,
    onRootMessage:
      options.onRootMessage ??
      ((message) => {
        rootMessages.push(message);
      }),
    onRootQuestion:
      options.onRootQuestion ??
      ((id, prompt) => {
        rootQuestions.push({ id, prompt });
      }),
  });
  return {
    root,
    cwd,
    sessionsDir,
    rootMessages,
    rootQuestions,
    runtime,
    run: (id) => runtime.list().find((run) => run.id === id),
    async dispose() {
      await runtime.close();
      await bin.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const scoutProfile = `  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    system: Inspect.
`;

const askingScoutProfiles = `  helper:
    description: Help.
    harness: claude
    model: haiku
    thinking: medium
    system: Help.
  scout:
    description: Inspect.
    harness: claude
    model: haiku
    thinking: medium
    delegates: [helper]
    system: Inspect.
`;

const workerWithScout = (
  harness: "claude" | "pi" = "claude",
  scout: string = scoutProfile,
) => `agents:
${scout}  worker:
    description: Implement.
    harness: ${harness}
    model: ${harness === "pi" ? "openai/gpt-test" : "opus"}
    thinking: medium
    delegates: [scout]
    system: Delegate.
`;

const leafWorker = (harness: "claude" | "pi") => `agents:
  worker:
    description: Work.
    harness: ${harness}
    model: ${harness === "pi" ? "openai/gpt-test" : "haiku"}
    thinking: medium
    system: Work.
`;

test("Nested delegation returns promptly, pushes child reports, and gives scouts no delegation", async () => {
  const fixture = await fixtureRuntime(workerWithScout(), {});
  const release = join(fixture.root, "release");
  const started = join(fixture.root, "started");
  const notifications = join(fixture.root, "notifications");
  const executables = await installExecutables({
    claude: claudeFixture(`
if (model === "haiku") {
  onPrompt(async (content) => {
    if (content === "Find the implementation") {
      while (!existsSync(${JSON.stringify(release)})) await sleep(5);
      const probe = await mcp.call("subagent_list", {}).catch((error) => error.message);
      await result("scout report; tools: " + probe);
      return;
    }
    await result("brief report");
  });
} else {
  onPrompt(async (content) => {
    if (content.startsWith("Subagent ")) {
      appendFileSync(${JSON.stringify(notifications)}, content + "\\n");
      await result(content);
      return;
    }
    const brief = await mcp.call("subagent_create", { id: "brief", name: "scout", prompt: "Find the brief" });
    const code = await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Find the implementation" });
    const listed = await mcp.call("subagent_list", {});
    writeFileSync(${JSON.stringify(started)}, JSON.stringify({ brief: JSON.parse(brief.text), child: JSON.parse(code.text), inventory: JSON.parse(listed.text) }));
    await result("Delegated scout");
  });
}
`),
  });
  try {
    const { runtime } = fixture;
    const worker = await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement the change",
    });
    assert.equal(worker.status, "running");
    const deadline = Date.now() + 2000;
    while (!existsSync(started) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(existsSync(started), "Nested create did not return promptly");
    assert.equal(fixture.run("implementation")?.status, "running");
    await until(() => fixture.run("brief")?.status === "idle");
    await writeFile(release, "");
    await until(() => fixture.run("implementation")?.status === "idle");
    const runs = runtime.list();
    const scout = runs.find((run) => run.id === "code");
    assert.equal(scout?.parentRunId, worker.runId);
    assert.deepEqual(
      runs
        .filter((run) => run.parentRunId === worker.runId)
        .map((run) => run.id),
      ["brief", "code"],
    );
    assert.equal(
      scout?.report,
      "scout report; tools: fixture has no MCP server",
    );
    const initial = JSON.parse(await readFile(started, "utf8")) as {
      child: { id: string; status: string };
      inventory: {
        kinds: Array<{ name: string }>;
        runs: Array<{ id: string }>;
      };
    };
    assert.deepEqual(initial.child, {
      id: "code",
      name: "scout",
      status: "running",
    });
    assert.deepEqual(
      initial.inventory.kinds.map((agent) => agent.name),
      ["scout"],
    );
    assert.ok(initial.inventory.runs.some((run) => run.id === "code"));
    const delivered = await readFile(notifications, "utf8");
    assert.equal(delivered.match(/Subagent brief is idle/g)?.length, 1);
    assert.equal(delivered.match(/Subagent code is idle/g)?.length, 1);
    assert.match(
      fixture.run("implementation")?.report ?? "",
      /Subagent code is idle\./,
    );
    assert.match(
      fixture.rootMessages[0] ?? "",
      /Subagent implementation is idle/,
    );
    const inventory = await runtime.inventory();
    assert.deepEqual(
      inventory.kinds.map((agent) => agent.name),
      ["scout", "worker"],
    );
    assert.deepEqual(
      inventory.runs.map((run) => [run.id, run.status]),
      [["implementation", "idle"]],
    );
  } finally {
    await writeFile(release, "");
    await fixture.dispose();
    await executables.dispose();
  }
});

test("subagent_wait returns the first child notice and consumed notices are not re-delivered", async () => {
  const fixture = await fixtureRuntime(workerWithScout(), {});
  const release = join(fixture.root, "release");
  const log = join(fixture.root, "log");
  const executables = await installExecutables({
    claude: claudeFixture(`
if (model === "haiku") {
  onPrompt(async (content) => {
    if (content === "slow") while (!existsSync(${JSON.stringify(release)})) await sleep(5);
    await result(content + " report");
  });
} else {
  onPrompt(async (content) => {
    if (content.startsWith("Subagent ")) {
      appendFileSync(${JSON.stringify(log)}, "turn:" + content + "\\n");
      await result(content);
      return;
    }
    const empty = await mcp.call("subagent_wait", {});
    appendFileSync(${JSON.stringify(log)}, "empty:" + empty.text + "\\n");
    await mcp.call("subagent_create", { id: "fast", name: "scout", prompt: "fast" });
    await mcp.call("subagent_create", { id: "slow", name: "scout", prompt: "slow" });
    const unknown = await mcp.call("subagent_wait", { ids: ["missing"] });
    appendFileSync(${JSON.stringify(log)}, "unknown:" + unknown.text + "\\n");
    const waited = await mcp.call("subagent_wait", {});
    appendFileSync(${JSON.stringify(log)}, "wait:" + waited.text + "\\n");
    await result("waited");
  });
}
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({ id: "owner", name: "worker", prompt: "Own" });
    await until(() => /^wait:/m.test(fileText(log)));
    const beforeRelease = await readFile(log, "utf8");
    assert.match(beforeRelease, /^empty:No directly owned subagents$/m);
    assert.match(
      beforeRelease,
      /^unknown:Unknown directly owned subagent missing$/m,
    );
    assert.match(beforeRelease, /^wait:Subagent fast is idle\.\nfast report$/m);
    assert.equal(fixture.run("owner")?.status, "running");
    await writeFile(release, "");
    await until(() => fixture.run("owner")?.status === "idle");
    const afterRelease = await readFile(log, "utf8");
    assert.match(afterRelease, /^turn:Subagent slow is idle\.\nslow report$/m);
    assert.equal(afterRelease.match(/Subagent fast is idle/g)?.length, 1);
  } finally {
    await writeFile(release, "");
    await fixture.dispose();
    await executables.dispose();
  }
});

for (const harness of ["claude", "pi"] as const) {
  test(`An idle ${harness} child keeps its session, resumes on a message, and stops`, async () => {
    const fixture = await fixtureRuntime(leafWorker(harness), {});
    const argsLog = join(fixture.root, "args");
    const source = `
appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + "\\n");
const sessionDir = args[args.indexOf("--session-dir") + 1];
const sessionId = args[args.indexOf("--session-id") + 1];
if (args.includes("--session-dir")) writeFileSync(sessionDir + "/20261110T000000_" + sessionId + ".jsonl", "");
onPrompt(async (content) => {
  await result("report for " + content);
});
`;
    const executables = await installExecutables({
      [harness]: harness === "pi" ? piFixture(source) : claudeFixture(source),
    });
    try {
      const { runtime } = fixture;
      const created = await runtime.create({
        id: "w",
        name: "worker",
        prompt: "first",
      });
      await until(() => fixture.run("w")?.status === "idle");
      const idle = fixture.run("w");
      assert.equal(idle?.report, "report for first");
      assert.equal(idle?.error, undefined);
      assert.ok((idle?.endedAt ?? 0) > 0);
      assert.equal(
        fixture.rootMessages[0],
        "Subagent w is idle.\nreport for first",
      );
      const expectedSession =
        harness === "claude"
          ? join(
              homedir(),
              ".claude",
              "projects",
              fixture.cwd.replace(/[^A-Za-z0-9]/g, "-"),
              `${created.runId}.jsonl`,
            )
          : join(fixture.sessionsDir, `20261110T000000_${created.runId}.jsonl`);
      assert.equal(idle?.session, expectedSession);
      if (harness === "pi") assert.ok(existsSync(expectedSession));
      assert.deepEqual((await runtime.inventory()).runs, [
        { id: "w", name: "worker", status: "idle", report: "report for first" },
      ]);
      await runtime.message(undefined, "w", "second");
      const resumed = fixture.run("w");
      assert.equal(resumed?.status, "running");
      assert.equal(resumed?.report, undefined);
      assert.equal(resumed?.endedAt, undefined);
      assert.notEqual(resumed?.pid, idle?.pid);
      await until(() => fixture.rootMessages.length === 2);
      assert.equal(
        fixture.rootMessages[1],
        "Subagent w is idle.\nreport for second",
      );
      const invocations = fileText(argsLog)
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(invocations.length, 2);
      if (harness === "claude") {
        assert.deepEqual(invocations[0]?.slice(0, 3), [
          "--print",
          "--session-id",
          created.runId,
        ]);
        assert.deepEqual(invocations[1]?.slice(0, 3), [
          "--print",
          "--resume",
          created.runId,
        ]);
      } else {
        for (const invocation of invocations)
          assert.deepEqual(invocation.slice(0, 6), [
            "--mode",
            "rpc",
            "--session-id",
            created.runId,
            "--session-dir",
            fixture.sessionsDir,
          ]);
      }
      assert.deepEqual(await runtime.stop(undefined, "w"), {
        id: "w",
        name: "worker",
        status: "stopped",
        report: "report for second",
      });
      assert.equal(fixture.rootMessages[2], "Subagent w was stopped.");
      await assert.rejects(
        runtime.message(undefined, "w", "third"),
        /^Error: Subagent w is stopped$/,
      );
      await assert.rejects(
        runtime.stop(undefined, "w"),
        /^Error: Subagent w is stopped$/,
      );
      assert.deepEqual((await runtime.inventory()).runs, []);
    } finally {
      await fixture.dispose();
      await executables.dispose();
    }
  });
}

test("An owner that exits before its child finishes fails and stops the child", async () => {
  const fixture = await fixtureRuntime(workerWithScout(), {});
  const executables = await installExecutables({
    claude: claudeFixture(`
if (model === "haiku") {
  onPrompt(async () => undefined);
} else {
  onPrompt(async () => {
    await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect" });
    await result("Owner exited early");
    process.exit(0);
  });
}
`),
  });
  try {
    const worker = await fixture.runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Delegate",
    });
    await until(() => fixture.run("implementation")?.status !== "running");
    const owner = fixture.run("implementation");
    assert.equal(owner?.status, "failed");
    assert.match(
      owner?.error ?? "",
      /^Harness exited with code 0 while waiting for child updates/,
    );
    await until(
      () =>
        fixture.runtime.list().find((run) => run.parentRunId === worker.runId)
          ?.status === "stopped",
    );
    await until(() => fixture.rootMessages.length > 0);
    assert.match(
      fixture.rootMessages[0] ?? "",
      /^Subagent implementation failed\./,
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("Pi worker delegates to an allowed Claude child", async () => {
  const fixture = await fixtureRuntime(
    `agents:
${scoutProfile}  worker-sol:
    description: Implement.
    harness: pi
    model: openai-codex/gpt-5.6-sol
    thinking: high
    delegates: [scout]
    system: Delegate before implementing.
`,
    {},
  );
  const settled = join(fixture.root, "worker-settled");
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  while (!existsSync(${JSON.stringify(settled)})) await sleep(5);
  await result("scout report");
});
`),
    pi: piFixture(`
if (model !== "openai-codex/gpt-5.6-sol" || args[args.indexOf("--thinking") + 1] !== "high" || !args.includes("--extension")) process.exit(1);
onPrompt(async (content) => {
  let output = content;
  if (!content.startsWith("Subagent ")) {
    const created = await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect the change" });
    output = created.text;
  }
  await result(JSON.stringify(output));
  setTimeout(() => writeFileSync(${JSON.stringify(settled)}, "ready"), 30);
});
`),
  });
  try {
    const worker = await fixture.runtime.create({
      id: "implementation",
      name: "worker-sol",
      prompt: "Implement the change",
    });
    await until(() => fixture.run("implementation")?.status !== "running");
    const idleWorker = fixture.run("implementation");
    assert.equal(idleWorker?.status, "idle", idleWorker?.error);
    const child = fixture.runtime
      .list()
      .find((run) => run.parentRunId === worker.runId);
    assert.equal(child?.agent, "scout");
    assert.equal(child?.report, "scout report");
    assert.match(idleWorker?.report ?? "", /scout report/);
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

for (const harness of ["claude", "pi"] as const) {
  test(`Stopping a ${harness} harness that exits cleanly without settlement marks it stopped`, async () => {
    const fixture = await fixtureRuntime(leafWorker(harness), {});
    const ready = join(fixture.root, "ready");
    const source = `
process.on("SIGTERM", () => process.exit(0));
onPrompt(async () => writeFileSync(${JSON.stringify(ready)}, ""));
`;
    const executables = await installExecutables({
      [harness]: harness === "pi" ? piFixture(source) : claudeFixture(source),
    });
    try {
      await fixture.runtime.create({
        id: "implementation",
        name: "worker",
        prompt: "Wait",
      });
      await until(() => existsSync(ready));
      assert.deepEqual(
        await fixture.runtime.stop(undefined, "implementation"),
        { id: "implementation", name: "worker", status: "stopped" },
      );
      await until(() => fixture.rootMessages.length > 0);
      assert.equal(
        fixture.rootMessages[0],
        "Subagent implementation was stopped.",
      );
    } finally {
      await fixture.dispose();
      await executables.dispose();
    }
  });
}

test("Stopping a direct running child stops it and wakes the root", async () => {
  const fixture = await fixtureRuntime(
    `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    system: Work until stopped.
`,
    {},
  );
  const executables = await installExecutables({
    claude: claudeFixture(`onPrompt(async () => undefined);`),
  });
  try {
    const { runtime } = fixture;
    const worker = await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await assert.rejects(
      runtime.stop(undefined, "missing"),
      /^Error: Unknown directly owned subagent missing$/,
    );
    await assert.rejects(
      runtime.stop(worker.runId, "implementation"),
      /^Error: Unknown directly owned subagent implementation$/,
    );
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "stopped",
    });
    await until(() => fixture.rootMessages.length > 0);
    assert.equal(
      fixture.rootMessages[0],
      "Subagent implementation was stopped.",
    );
    await assert.rejects(
      runtime.stop(undefined, "implementation"),
      /^Error: Subagent implementation is stopped$/,
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("Stopping a waiting direct child clears its question and stops its running child", async () => {
  const fixture = await fixtureRuntime(
    workerWithScout("claude", askingScoutProfiles),
    {},
  );
  const executables = await installExecutables({
    claude: claudeFixture(`
if (model === "haiku") {
  onPrompt(async () => undefined);
} else {
  onPrompt(async () => {
    void mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect" }).catch(() => undefined);
    await mcp.call("subagent_ask", { prompt: "Which API?" });
  });
}
`),
  });
  try {
    const { runtime } = fixture;
    const worker = await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    const scout = () =>
      runtime.list().find((run) => run.parentRunId === worker.runId);
    await until(
      () =>
        fixture.run("implementation")?.status === "waiting" &&
        scout()?.status === "running",
    );
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "stopped",
    });
    await until(() => scout()?.status === "stopped");
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A stopping child accepts no new work and ends stopped even when its turn settles", async () => {
  const fixture = await fixtureRuntime(workerWithScout(), {});
  const ready = join(fixture.root, "ready");
  const attempts = join(fixture.root, "attempts");
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  process.on("SIGTERM", async () => {
    const created = await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect" });
    const asked = await mcp.call("subagent_ask", { prompt: "Which API?" });
    writeFileSync(${JSON.stringify(attempts)}, JSON.stringify([created, asked]));
    await result("finished on stop");
    process.exit(0);
  });
  await mcp.call("subagent_list", {});
  writeFileSync(${JSON.stringify(ready)}, "");
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => existsSync(ready));
    const stopped = runtime.stop(undefined, "implementation");
    await assert.rejects(
      runtime.stop(undefined, "implementation"),
      /^Error: Subagent implementation is stopping$/,
    );
    await assert.rejects(
      runtime.message(undefined, "implementation", "Continue"),
      /^Error: Subagent implementation is stopping$/,
    );
    assert.deepEqual(await stopped, {
      id: "implementation",
      name: "worker",
      status: "stopped",
      report: "finished on stop",
    });
    assert.deepEqual(JSON.parse(await readFile(attempts, "utf8")), [
      { text: "Agent is not running", isError: true },
      { text: "Agent is not running", isError: true },
    ]);
    assert.deepEqual(
      runtime.list().map((run) => [run.id, run.status]),
      [["implementation", "stopped"]],
    );
    await until(() => fixture.rootMessages.length > 0);
    assert.equal(
      fixture.rootMessages[0],
      "Subagent implementation was stopped.",
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A stopped subtree accepts no work after the stop target is stopped", async () => {
  const fixture = await fixtureRuntime(
    `agents:
${askingScoutProfiles}  lead:
    description: Coordinate.
    harness: claude
    model: sonnet
    thinking: medium
    delegates: [scout]
    system: Coordinate.
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [lead]
    system: Implement.
`,
    {},
  );
  const ready = join(fixture.root, "ready");
  const go = join(fixture.root, "go");
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  if (model === "opus") {
    void mcp.call("subagent_create", { id: "coordination", name: "lead", prompt: "Coordinate" }).catch(() => undefined);
    return;
  }
  process.on("SIGTERM", async () => {
    while (!existsSync(${JSON.stringify(go)})) await sleep(5);
    const outcome = model === "sonnet"
      ? await mcp.call("subagent_message", { id: "code", message: "Continue" })
      : await mcp.call("subagent_ask", { prompt: "Which API?" });
    writeFileSync(${JSON.stringify(fixture.root)} + "/" + model, JSON.stringify(outcome));
    process.exit(0);
  });
  if (model === "sonnet") {
    await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect" });
    return;
  }
  writeFileSync(${JSON.stringify(ready)}, "");
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => existsSync(ready));
    assert.deepEqual(await runtime.stop(undefined, "implementation"), {
      id: "implementation",
      name: "worker",
      status: "stopped",
    });
    await writeFile(go, "");
    await until(
      () =>
        existsSync(join(fixture.root, "sonnet")) &&
        existsSync(join(fixture.root, "haiku")),
    );
    const fromLead = JSON.parse(
      await readFile(join(fixture.root, "sonnet"), "utf8"),
    ) as { text: string; isError: boolean };
    assert.equal(fromLead.isError, true);
    assert.match(fromLead.text, /^Subagent code is stopp(ing|ed)$/);
    assert.deepEqual(
      JSON.parse(await readFile(join(fixture.root, "haiku"), "utf8")),
      { text: "Agent is not running", isError: true },
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

const askingWorker = `agents:
  worker:
    description: Implement.
    harness: claude
    model: opus
    thinking: medium
    delegates: [helper]
    system: Ask when blocked.
  helper:
    description: Help.
    harness: claude
    model: haiku
    thinking: medium
    system: Help.
`;

test("A top-level question notifies the owner and waits for its message", async () => {
  const fixture = await fixtureRuntime(askingWorker, {});
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  const response = await mcp.call("subagent_ask", { prompt: "Which API?" });
  await result(response.text);
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await assert.rejects(
      runtime.create({
        id: "implementation",
        name: "worker",
        prompt: "Duplicate",
      }),
      /Duplicate directly owned subagent id/,
    );
    await until(() => fixture.run("implementation")?.status === "waiting");
    const waiting = await runtime.inventory();
    assert.deepEqual(waiting.runs, [
      {
        id: "implementation",
        name: "worker",
        status: "waiting",
        question: "Which API?",
      },
    ]);
    assert.deepEqual(fixture.rootQuestions, [
      { id: "implementation", prompt: "Which API?" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(fixture.run("implementation")?.status, "waiting");
    await runtime.message(undefined, "implementation", "Use the stable API");
    await until(() => fixture.run("implementation")?.status === "idle");
    assert.equal(fixture.run("implementation")?.report, "Use the stable API");
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A nested question wakes the direct parent and resumes on its answer", async () => {
  const fixture = await fixtureRuntime(
    workerWithScout("claude", askingScoutProfiles),
    {},
  );
  const response = join(fixture.root, "response");
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async (content) => {
  if (model === "haiku") {
    const answer = await mcp.call("subagent_ask", { prompt: "Which file?" });
    await result("scout read " + answer.text);
    return;
  }
  if (content.includes("Subagent code is idle")) {
    await result(content);
    return;
  }
  if (content.includes("Subagent code is waiting")) {
    const resumed = await mcp.call("subagent_message", { id: "code", message: "runtime.ts" });
    writeFileSync(${JSON.stringify(response)}, resumed.text);
    await result("Answered scout");
    return;
  }
  const asked = await mcp.call("subagent_create", { id: "code", name: "scout", prompt: "Inspect" });
  await result(asked.text);
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    const deadline = Date.now() + 3000;
    while (
      fixture.run("implementation")?.status === "running" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const finishedWorker = fixture.run("implementation");
    assert.equal(
      finishedWorker?.status,
      "idle",
      finishedWorker?.error ?? "Nested question stalled",
    );
    assert.deepEqual(JSON.parse(await readFile(response, "utf8")), {
      id: "code",
      name: "scout",
      status: "running",
    });
    assert.match(finishedWorker?.report ?? "", /scout read runtime.ts/);
    assert.deepEqual(fixture.rootQuestions, []);
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A question abandoned by an exiting subagent is cleared and a later message resumes it", async () => {
  const abandonFile = { path: "" };
  const fixture = await fixtureRuntime(
    askingWorker,
    {},
    {
      onRootQuestion: async () => {
        await writeFile(abandonFile.path, "");
      },
    },
  );
  abandonFile.path = join(fixture.root, "abandon");
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async (content) => {
  if (args.includes("--resume")) {
    await result("resumed with " + content);
    return;
  }
  mcp.call("subagent_ask", { prompt: "Which API?" }).catch(() => undefined);
  while (!existsSync(${JSON.stringify(abandonFile.path)})) await sleep(5);
  await result("abandoned the question");
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => fixture.run("implementation")?.status === "idle");
    assert.equal(
      fixture.run("implementation")?.report,
      "abandoned the question",
    );
    assert.equal(fixture.run("implementation")?.question, undefined);
    assert.equal(
      fixture.rootMessages[0],
      "Subagent implementation is idle.\nabandoned the question",
    );
    await runtime.message(undefined, "implementation", "Use the stable API");
    await until(() => fixture.rootMessages.length === 2);
    assert.equal(
      fixture.rootMessages[1],
      "Subagent implementation is idle.\nresumed with Use the stable API",
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A failing root question handler rejects the pending question", async () => {
  const statuses: string[] = [];
  const fixture = await fixtureRuntime(
    askingWorker,
    {},
    {
      onUpdate: (runs) => {
        const status = runs[0]?.status;
        if (status && statuses.at(-1) !== status) statuses.push(status);
      },
      onRootQuestion: () => {
        throw new Error("Owner could not be notified");
      },
    },
  );
  const executables = await installExecutables({
    claude: claudeFixture(`
onPrompt(async () => {
  const response = await mcp.call("subagent_ask", { prompt: "Which API?" });
  await result(response.text);
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({
      id: "implementation",
      name: "worker",
      prompt: "Implement",
    });
    await until(() => fixture.run("implementation")?.status === "idle");
    assert.equal(
      fixture.run("implementation")?.report,
      "Owner could not be notified",
    );
    assert.equal(fixture.run("implementation")?.question, undefined);
    assert.match(statuses.join(","), /waiting,running/);
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

const idleScout = claudeFixture(`
process.on("SIGTERM", () => process.exit(0));
if (model === "haiku") {
  onPrompt(async () => undefined);
} else {
  onPrompt(async () => {
    await mcp.call("subagent_create", { id: "scout", name: "scout", prompt: "Inspect" });
    await result("delegated");
    if (process.env.OWNER_EXITS) setTimeout(() => process.exit(0), 50);
  });
}
`);

const idlePiOwner = piFixture(`
process.on("SIGTERM", () => process.exit(143));
onPrompt(async () => {
  await mcp.call("subagent_create", { id: "scout", name: "scout", prompt: "Inspect" });
  await write({ type: "agent_settled" });
});
`);

for (const harness of ["claude", "pi"] as const) {
  test(`Stopping a settled ${harness} owner that waits for its child stops both`, async () => {
    const fixture = await fixtureRuntime(workerWithScout(harness), {});
    const executables = await installExecutables({
      claude: idleScout,
      ...(harness === "pi" ? { pi: idlePiOwner } : {}),
    });
    try {
      const { runtime } = fixture;
      await runtime.create({ id: "owner", name: "worker", prompt: "Own" });
      await until(() =>
        runtime.list().some((run) => run.id === "scout" && run.pid > 0),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fixture.run("owner")?.status, "running");
      const stopped = await runtime.stop(undefined, "owner");
      assert.equal(stopped.status, "stopped");
      await until(() =>
        runtime.list().every((run) => run.status === "stopped"),
      );
    } finally {
      await fixture.dispose();
      await executables.dispose();
    }
  });
}

test("A child still running when its owner exits is stopped", async () => {
  process.env.OWNER_EXITS = "1";
  const fixture = await fixtureRuntime(workerWithScout(), {});
  const executables = await installExecutables({ claude: idleScout });
  try {
    const { runtime } = fixture;
    await runtime.create({ id: "owner", name: "worker", prompt: "Own" });
    await until(
      () =>
        runtime.list().length === 2 &&
        runtime.list().every((run) => run.endedAt !== undefined),
    );
    assert.deepEqual(
      runtime
        .list()
        .map((run) => [run.id, run.status, run.error?.split("\n")[0]]),
      [
        [
          "owner",
          "failed",
          "Harness exited with code 0 while waiting for child updates",
        ],
        ["scout", "stopped", undefined],
      ],
    );
    assert.match(
      fixture.rootMessages[0] ?? "",
      /^Subagent owner failed\.\nHarness exited with code 0 while waiting for child updates\n/,
    );
  } finally {
    delete process.env.OWNER_EXITS;
    await fixture.dispose();
    await executables.dispose();
  }
});

test("A harness killed by a signal this runtime did not send fails with the signal", async () => {
  const fixture = await fixtureRuntime(leafWorker("claude"), {});
  const executables = await installExecutables({
    claude: claudeFixture(
      `onPrompt(() => process.kill(process.pid, "SIGKILL"));`,
    ),
  });
  try {
    await fixture.runtime.create({
      id: "worker",
      name: "worker",
      prompt: "Work",
    });
    await until(() => fixture.rootMessages.length > 0);
    assert.equal(
      fixture.rootMessages[0],
      "Subagent worker failed.\nAgent was terminated by SIGKILL",
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});

test("An owner that ends its turn without answering is reminded of the question", async () => {
  const fixture = await fixtureRuntime(
    workerWithScout("claude", askingScoutProfiles),
    {},
  );
  const executables = await installExecutables({
    claude: claudeFixture(`
let questions = 0;
onPrompt(async (content) => {
  if (model === "haiku") {
    const answer = await mcp.call("subagent_ask", { prompt: "Which file?" });
    await result("scout read " + answer.text);
    return;
  }
  if (content.includes("Subagent scout is idle")) {
    await result(content + " after " + questions + " questions");
    return;
  }
  if (content.includes("Subagent scout is waiting")) {
    questions += 1;
    if (questions === 2) await mcp.call("subagent_message", { id: "scout", message: "runtime.ts" });
    await result("Waiting on scout");
    return;
  }
  await mcp.call("subagent_create", { id: "scout", name: "scout", prompt: "Inspect" });
  await result("Started scout");
});
`),
  });
  try {
    const { runtime } = fixture;
    await runtime.create({ id: "owner", name: "worker", prompt: "Own" });
    await until(() => fixture.run("owner")?.endedAt !== undefined);
    const owner = fixture.run("owner");
    assert.equal(owner?.status, "idle", owner?.error);
    assert.match(
      owner?.report ?? "",
      /scout read runtime\.ts after 2 questions$/,
    );
  } finally {
    await fixture.dispose();
    await executables.dispose();
  }
});
