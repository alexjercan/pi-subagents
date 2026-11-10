import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TObject, type TSchema } from "typebox";
import {
  failure,
  type SubagentToolName,
  type ToolCall,
  type ToolField,
  type ToolSpec,
} from "./tools.ts";

export type ToolRenderers = Partial<
  Record<
    SubagentToolName,
    Pick<
      Parameters<ExtensionAPI["registerTool"]>[0],
      "renderCall" | "renderResult"
    >
  >
>;

function parameters(fields: Record<string, ToolField>): TObject {
  const properties: Record<string, TSchema> = {};
  for (const [name, field] of Object.entries(fields)) {
    const base = field.list
      ? Type.Array(Type.String({ minLength: 1 }), {
          description: field.description,
        })
      : Type.String({ minLength: 1, description: field.description });
    properties[name] = field.optional ? Type.Optional(base) : base;
  }
  return Type.Object(properties);
}

export function registerPiTools(
  pi: ExtensionAPI,
  tools: readonly ToolSpec[],
  call: ToolCall,
  renderers: ToolRenderers = {},
): void {
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      parameters: parameters(tool.fields),
      async execute(_toolCallId, params, signal) {
        try {
          return await call(
            tool.name,
            params as Record<string, unknown>,
            signal,
          );
        } catch (error) {
          return { ...failure(error), details: { error: true } };
        }
      },
      ...renderers[tool.name],
    });
  }
}
