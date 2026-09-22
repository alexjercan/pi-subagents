import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseDocument } from "yaml";
import type {
  ClaudePermissionMode,
  ClaudeThinkingLevel,
  HarnessConfig,
  PiThinkingLevel,
} from "./harness.ts";

const piThinkingLevels = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const claudeThinkingLevels = new Set<ClaudeThinkingLevel>([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const claudePermissionModes = new Set<ClaudePermissionMode>([
  "auto",
  "bypassPermissions",
]);
const rootKeys = new Set(["agents"]);
const agentKeys = new Set([
  "description",
  "harness",
  "model",
  "thinking",
  "permissionMode",
  "tools",
  "delegates",
  "system",
]);
const agentTools = new Set<AgentTool>([
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "edit",
  "write",
  "web_search",
  "web_fetch",
]);

export type AgentTool =
  | "read"
  | "grep"
  | "find"
  | "ls"
  | "bash"
  | "edit"
  | "write"
  | "web_search"
  | "web_fetch";

export interface AgentProfile {
  name: string;
  description: string;
  config: HarnessConfig;
  system: string;
  tools?: AgentTool[];
  delegates: string[];
  source: "user" | "project";
  path: string;
}

export interface LoadAgentProfilesOptions {
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
}

function object(value: unknown, location: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${location} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  location: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0)
    throw new Error(`${location} has unknown field ${unknown[0]}`);
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  location: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0)
    throw new Error(`${location}.${key} must be a non-empty string`);
  return field;
}

function tools(value: unknown, location: string): AgentTool[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new Error(`${location}.tools must be an array`);
  for (const tool of value) {
    if (typeof tool !== "string" || !agentTools.has(tool as AgentTool))
      throw new Error(
        `${location}.tools contains unknown tool ${String(tool)}`,
      );
  }
  return [...value] as AgentTool[];
}

function delegates(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.some((agent) => typeof agent !== "string" || agent.length === 0)
  ) {
    throw new Error(
      `${location}.delegates must be an array of non-empty strings`,
    );
  }
  return [...value] as string[];
}

function permissionMode(
  value: unknown,
  location: string,
): ClaudePermissionMode {
  if (value === undefined) return "bypassPermissions";
  if (
    typeof value !== "string" ||
    !claudePermissionModes.has(value as ClaudePermissionMode)
  ) {
    throw new Error(
      `${location}.permissionMode must be auto or bypassPermissions`,
    );
  }
  return value as ClaudePermissionMode;
}

function harnessConfig(
  value: Record<string, unknown>,
  location: string,
): HarnessConfig {
  const harness = requiredString(value, "harness", location);
  const model = requiredString(value, "model", location);
  const thinking = requiredString(value, "thinking", location);
  if (harness !== "pi" && harness !== "claude")
    throw new Error(`${location}.harness must be pi or claude`);
  if (harness === "pi") {
    if (value.permissionMode !== undefined)
      throw new Error(`${location}.permissionMode requires the claude harness`);
    if (!piThinkingLevels.has(thinking as PiThinkingLevel))
      throw new Error(`${location}.thinking is not supported by ${harness}`);
    return { harness, model, thinking: thinking as PiThinkingLevel };
  }
  if (!claudeThinkingLevels.has(thinking as ClaudeThinkingLevel))
    throw new Error(`${location}.thinking is not supported by ${harness}`);
  return {
    harness,
    model,
    thinking: thinking as ClaudeThinkingLevel,
    permissionMode: permissionMode(value.permissionMode, location),
  };
}

async function yaml(path: string): Promise<unknown | undefined> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      `${path}: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }
  return document.toJS();
}

async function profiles(
  path: string,
  source: "user" | "project",
): Promise<AgentProfile[]> {
  const value = await yaml(path);
  if (value === undefined) return [];
  const root = object(value, path);
  exactKeys(root, rootKeys, path);
  const agents = object(root.agents, `${path}.agents`);
  return Object.entries(agents).map(([name, candidate]) => {
    if (name.length === 0)
      throw new Error(`${path}.agents contains an empty name`);
    const location = `${path}.agents.${name}`;
    const agent = object(candidate, location);
    exactKeys(agent, agentKeys, location);
    const config = harnessConfig(agent, location);
    const allowedDelegates = delegates(agent.delegates, location);
    if (config.harness !== "claude" && allowedDelegates.length > 0)
      throw new Error(`${location}.delegates requires the claude harness`);
    return {
      name,
      description: requiredString(agent, "description", location),
      config,
      system: requiredString(agent, "system", location),
      tools: tools(agent.tools, location),
      delegates: allowedDelegates,
      source,
      path,
    };
  });
}

export async function loadAgentProfiles(
  options: LoadAgentProfilesOptions,
): Promise<AgentProfile[]> {
  const userPath = join(options.agentDir ?? getAgentDir(), "subagents.yaml");
  const projectPath = join(options.cwd, CONFIG_DIR_NAME, "subagents.yaml");
  const merged = new Map(
    (await profiles(userPath, "user")).map((profile) => [
      profile.name,
      profile,
    ]),
  );
  if (options.projectTrusted) {
    for (const profile of await profiles(projectPath, "project"))
      merged.set(profile.name, profile);
  }
  const loaded = [...merged.values()];
  const names = new Set(loaded.map((profile) => profile.name));
  for (const profile of loaded) {
    for (const delegate of profile.delegates) {
      if (!names.has(delegate))
        throw new Error(
          `${profile.path}.agents.${profile.name} delegates to unknown agent ${delegate}`,
        );
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name))
      throw new Error(`agent delegation cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    const profile = loaded.find((candidate) => candidate.name === name);
    for (const delegate of profile?.delegates ?? []) visit(delegate);
    visiting.delete(name);
    visited.add(name);
  };
  for (const profile of loaded) visit(profile.name);
  return loaded;
}
