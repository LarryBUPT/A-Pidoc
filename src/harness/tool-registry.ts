import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import type { AgentTask, HarnessTool, ToolResult } from "./contracts.js";
import type { ToolInvocation } from "./pi-loop-adapter.js";
import { canonicalJson } from "./digest.js";
import { redactValue } from "../security/redaction.js";

export class ToolRegistry {
  private readonly tools = new Map<string, HarnessTool>();
  constructor(tools: HarnessTool[]) {
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new Error("INVALID_TOOL_REGISTRY");
      if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) throw new Error("CLOSED_OBJECT_SCHEMA_REQUIRED");
      if (!tool.description.trim() || !tool.bundle.trim() || tool.concurrency.maxConcurrency !== undefined && (!Number.isInteger(tool.concurrency.maxConcurrency) || tool.concurrency.maxConcurrency < 1)) throw new Error("INVALID_TOOL_METADATA");
      this.tools.set(tool.name, tool);
    }
  }
  get(name: string): HarnessTool | undefined { return this.tools.get(name); }
  toPiTools(task: AgentTask, executionGate?: (call: ToolInvocation, execute: () => Promise<ToolResult>) => Promise<ToolResult>): AgentTool[] {
    return [...this.tools.values()].filter(t => task.allowedToolBundles.includes(t.bundle)).map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema), executionMode: "sequential", replay: "never",
      execute: async (id, args, signal) => {
        // Secrets come from controlled backends, never from LLM tool arguments.
        const encoded = canonicalJson(args);
        if (encoded !== canonicalJson(redactValue(args))) throw new Error("SENSITIVE_TOOL_ARGUMENTS");
        try {
          const execute = () => tool.execute(args, { runId: task.id, environment: task.environment, ...(signal ? { signal } : {}) });
          const result = executionGate ? await executionGate({ id, name: tool.name, args }, execute) : await execute();
          const safe = redactValue(result.data);
          const warnings = redactValue(result.warnings) as string[];
          const bounded = { ...result, data: safe, warnings, redacted: true as const };
          if (Buffer.byteLength(JSON.stringify(bounded)) > 32_768) throw new Error("TOOL_OUTPUT_TOO_LARGE");
          if (!result.success) throw new Error("TOOL_EXECUTION_FAILED");
          return { content: [{ type: "text", text: JSON.stringify(bounded) }], details: bounded };
        } catch { throw new Error("TOOL_EXECUTION_FAILED"); }
      }
    }));
  }
}
