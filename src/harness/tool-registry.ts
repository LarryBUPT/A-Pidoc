import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { AgentTask, HarnessTool, ToolResult } from "./contracts.js";
import type { ToolInvocation } from "./pi-loop-adapter.js";
import { canonicalJson } from "./digest.js";
import { redactValue } from "../security/redaction.js";
import { PublicError } from "../security/errors.js";

const KNOWN_TOOL_ERROR_CODES = new Set([
  "EXECUTION_POLICY_CHANGED",
  "EXECUTION_PRECONDITION_CHANGED",
  "EXECUTION_RUN_INACTIVE",
  "EVIDENCE_ID_COLLISION",
  "EVIDENCE_OUTPUT_LIMIT",
  "HTTP_CANCELLED",
  "INVALID_API_REQUEST",
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
  "TOOL_NOT_ALLOWED",
  "TOOL_OUTPUT_TOO_LARGE",
  "UNKNOWN_API_OPERATION",
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
  async execute(task: AgentTask, call: ToolInvocation, signal?: AbortSignal, executionGate?: (call: ToolInvocation, execute: () => Promise<ToolResult>) => Promise<ToolResult>): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool || !task.allowedToolBundles.includes(tool.bundle)) throw new Error("TOOL_NOT_ALLOWED");
    // Secrets come from controlled backends, never from Agent or MCP tool arguments.
    if (canonicalJson(call.args) !== canonicalJson(redactValue(call.args))) throw new Error("SENSITIVE_TOOL_ARGUMENTS");
    try {
      const execute = () => tool.execute(call.args, { runId: task.id, toolCallId: call.id, environment: task.environment, ...(signal ? { signal } : {}) });
      const result = executionGate ? await executionGate(call, execute) : await execute();
      const bounded = { ...result, data: redactValue(result.data), warnings: redactValue(result.warnings) as string[], redacted: true as const };
      if (Buffer.byteLength(JSON.stringify(bounded)) > 32_768) throw new Error("TOOL_OUTPUT_TOO_LARGE");
      if (!result.success) throw new Error("TOOL_EXECUTION_FAILED");
      return bounded;
    } catch (error) {
      if (error instanceof PublicError) throw new Error(error.code);
      if (isKnownToolError(error)) throw error;
      throw new Error("TOOL_EXECUTION_FAILED");
    }
  }
  toPiTools(task: AgentTask, executionGate?: (call: ToolInvocation, execute: () => Promise<ToolResult>) => Promise<ToolResult>): AgentTool[] {
    return [...this.tools.values()].filter(t => task.allowedToolBundles.includes(t.bundle)).map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.inputSchema, executionMode: "sequential", replay: "never",
      execute: async (id, args, signal) => {
        const bounded = await this.execute(task, { id, name: tool.name, args }, signal, executionGate);
        return { content: [{ type: "text", text: JSON.stringify(bounded) }], details: bounded };
      }
    }));
  }
}
