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

export function spawnJsonlProcess(
  spec: ProcessSpec,
  onRecord: (value: unknown) => void,
): ProcessRun {
  const child = crossSpawn.spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    child.once("error", () => undefined);
    throw new Error(`Could not start ${spec.command}`);
  }

  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  let stdout = "";
  let stderr = "";
  let protocolError: Error | undefined;
  let ended = false;

  const parseLine = (line: string) => {
    const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (normalized.length === 0) return;
    try {
      onRecord(JSON.parse(normalized));
    } catch (error) {
      protocolError = error instanceof Error ? error : new Error(String(error));
      child.kill("SIGTERM");
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

  child.stdout.on("data", (chunk: Buffer) => {
    stdout += stdoutDecoder.write(chunk);
    parseLines();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += stderrDecoder.write(chunk);
  });

  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      ended = true;
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
    pid: child.pid,
    completion,
    send: async (value) => {
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
    stop: () => {
      child.kill("SIGTERM");
    },
  };
}
