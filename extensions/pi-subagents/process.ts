import crossSpawn from "cross-spawn";
import { StringDecoder } from "node:string_decoder";

interface ProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}

interface ProcessRun {
  pid: number;
  completion: Promise<ProcessResult>;
  send(value: unknown): Promise<void>;
  end(): void;
  stop(): void;
}

const STOP_GRACE_MS = 5000;
const liveGroups = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function killLiveGroups(): void {
  for (const pid of liveGroups) signalGroup(pid, "SIGKILL");
}

function trackGroup(pid: number): void {
  if (liveGroups.size === 0) process.on("exit", killLiveGroups);
  liveGroups.add(pid);
}

function untrackGroup(pid: number): void {
  liveGroups.delete(pid);
  if (liveGroups.size === 0) process.off("exit", killLiveGroups);
}

export function spawnJsonlProcess(
  spec: ProcessSpec,
  onRecord: (value: unknown) => void,
): ProcessRun {
  const child = crossSpawn.spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pid = child.pid;
  if (pid === undefined) {
    child.once("error", () => undefined);
    throw new Error(`Could not start ${spec.command}`);
  }
  trackGroup(pid);

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let protocolError: Error | undefined;
  let inputError: Error | undefined;
  let ended = false;
  let killTimer: NodeJS.Timeout | undefined;

  const stop = () => {
    if (ended || killTimer) return;
    signalGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), STOP_GRACE_MS);
  };

  const parseLine = (line: string) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.length === 0) return;
    try {
      onRecord(JSON.parse(normalized));
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
      stop();
    }
  };

  const parseLines = () => {
    while (true) {
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      parseLine(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
    }
  };

  child.stdin.on("error", (error) => {
    inputError = error;
  });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += stdoutDecoder.write(chunk);
    parseLines();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += stderrDecoder.write(chunk);
  });
  child.on("exit", () => signalGroup(pid, "SIGKILL"));

  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.on("error", reject);
    child.once("close", (exitCode, signal) => {
      ended = true;
      clearTimeout(killTimer);
      untrackGroup(pid);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      parseLines();
      if (stdout.length > 0) parseLine(stdout);
      if (protocolError) {
        reject(protocolError);
        return;
      }
      resolve({ exitCode, signal, stderr });
    });
  });

  return {
    pid,
    completion,
    send: async (value) => {
      if (inputError) throw inputError;
      if (ended || child.stdin.destroyed || !child.stdin.writable)
        throw new Error("Harness input is closed");
      const record = `${JSON.stringify(value)}\n`;
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(record, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    end: () => {
      if (!ended && !child.stdin.destroyed) child.stdin.end();
    },
    stop,
  };
}
