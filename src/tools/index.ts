import { z } from "zod";
import type { CortexStore } from "../store.js";
import { registerProjectTools } from "./project-tools.js";
import { registerMemoryTools } from "./memory-tools.js";
import { registerSessionTools } from "./session-tools.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
export type SafeToolFn = (
  name: string,
  description: string,
  schema: Record<string, z.ZodType>,
  handler: ToolHandler,
) => void;

function wrapHandler(handler: ToolHandler): ToolHandler {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof Error && err.stack) {
        console.error(err.stack);
      }
      return {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      };
    }
  };
}

export function registerTools(
  server: {
    tool: (
      name: string,
      description: string,
      schema: Record<string, z.ZodType>,
      handler: ToolHandler,
    ) => void;
  },
  store: CortexStore,
) {
  const safeTool: SafeToolFn = (name, description, schema, handler) =>
    server.tool(name, description, schema, wrapHandler(handler));

  registerProjectTools(safeTool, store);
  registerMemoryTools(safeTool, store);
  registerSessionTools(safeTool, store);
}
