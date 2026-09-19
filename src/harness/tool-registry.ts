import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentTask, HarnessTool, ToolResult } from "./contracts.js";
import type { ToolInvocation } from "./pi-loop-adapter.js";
import { canonicalJson } from "./digest.js";
import { redactValue } from "../security/redaction.js";

const KNOWN_TOOL_ERROR_CODES = new Set([
  "EXECUTION_POLICY_CHANGED",
  "EXECUTION_PRECONDITION_CHANGED",
  "EXECUTION_RUN_INACTIVE",
  "EVIDENCE_ID_COLLISION",
  "EVIDENCE_OUTPUT_LIMIT",
  "HTTP_CANCELLED",
  "INVALID_EVIDENCE_ID",
  "INVALID_EVIDENCE_INSPECTION",
  "INVALID_HYPOTHESIS",
  "INVALID_TOOL_EVIDENCE",
  "LOG_STORE_LIMIT",
  "PATCH_PRECONDITION_FAILED",
  "PATH_ESCAPE",
  "PUBLICATION_MISSING_EVIDENCE",
  "REGISTERED_WORKSPACE_LIMIT",
  "SANDBOX_NETWORK_BOUNDARY",
  "SENSITIVE_TOOL_ARGUMENTS",
  "SENSITIVE_APPROVAL_ARGUMENTS",
  "SUPPORT_STORE_LIMIT",
  "SYMLINK_WORKSPACE_REJECTED",
  "TOOL_EXECUTION_FAILED",
  "TOOL_OUTPUT_TOO_LARGE",
  "UNKNOWN_TOOL",
  "UNKNOWN_EVIDENCE_TOOL",
  "UNTRUSTED_CONTROL_MUTATION",
  "UNREGISTERED_RUNTIME_PROFILE",
  "UNSUPPORTED_WORKSPACE_ENTRY",
  "WORKSPACE_MUST_BE_OUTSIDE_SOURCE",
  "WRONG_ARTIFACT_KIND"
]);

export function isKnownToolError(error: unknown): error is Error {
  return error instanceof Error && KNOWN_TOOL_ERROR_CODES.has(error.message);
}

export class ToolRegistry {
  private readonly tools = new Map<string, HarnessTool>();
  constructor(tools: HarnessTool[]) {
    for (const tool of tools) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || this.tools.has(tool.name)) throw new Error("INVALID_TOOL_REGISTRY");
      if (tool.inputSchema.type !== "object" || tool.inputSchema.additionalProperties !== false) throw new Error("CLOSED_OBJECT_SCHEMA_REQUIRED");
      if(tool.progressMode!==undefined&&!["observe","inspect","submit"].includes(tool.progressMode))throw new Error("INVALID_PROGRESS_MODE");
      if (!tool.description.trim() || !tool.bundle.trim() || tool.concurrency.maxConcurrency !== undefined && (!Number.isInteger(tool.concurrency.maxConcurrency) || tool.concurrency.maxConcurrency < 1)) throw new Error("INVALID_TOOL_METADATA");
      this.tools.set(tool.name, tool);
    }
  }
  get(name: string): HarnessTool | undefined { return this.tools.get(name); }
  toPiTools(task: AgentTask, executionGate?: (call: ToolInvocation, execute: () => Promise<ToolResult>) => Promise<ToolResult>): AgentTool[] {
    return [...this.tools.values()].filter(t => task.allowedToolBundles.includes(t.bundle)).map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.inputSchema, executionMode: "sequential", replay: "never",
      execute: async (id, args, signal) => {
        // Secrets come from controlled backends, never from LLM tool arguments.
        const encoded = canonicalJson(args);
        if (encoded !== canonicalJson(redactValue(args))) throw new Error("SENSITIVE_TOOL_ARGUMENTS");
        try {
          const execute = () => tool.execute(args, { runId: task.id, toolCallId: id, environment: task.environment, ...(signal ? { signal } : {}) });
          const result = executionGate ? await executionGate({ id, name: tool.name, args }, execute) : await execute();
          const safe = redactValue(result.data);
          const warnings = redactValue(result.warnings) as string[];
          const bounded = { ...result, data: safe, warnings, redacted: true as const };
          if (Buffer.byteLength(JSON.stringify(bounded)) > 32_768) throw new Error("TOOL_OUTPUT_TOO_LARGE");
          if (!result.success) throw new Error("TOOL_EXECUTION_FAILED");
          return { content: [{ type: "text", text: JSON.stringify(bounded) }], details: bounded };
        } catch (error) {
          if (isKnownToolError(error)) throw error;
          throw new Error("TOOL_EXECUTION_FAILED");
        }
      }
    }));
  }
}
