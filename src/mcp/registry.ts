import { randomUUID } from "node:crypto";
import type { ApiActionDescriptor } from "../api-harness/api-guardrail.js";
import { ApiGuardrail } from "../api-harness/api-guardrail.js";
import { ConvergentWorkspace } from "../api-harness/convergent-workspace.js";
import type { ToolBackend } from "../api-harness/tool-bundles.js";
import { digest } from "../harness/digest.js";
import type { AgentTask, ToolResult } from "../harness/contracts.js";
import type { ToolInvocation } from "../harness/pi-loop-adapter.js";
import { ToolRegistry } from "../harness/tool-registry.js";
import { appendStep, TrajectoryStore } from "../harness/trajectory-store.js";
import { describeOpenApiDocument } from "../input/openapi-parser.js";
import { redactValue } from "../security/redaction.js";
import { createExecuteHttpTool, requestForOperation } from "./tools/execute-http.js";
import { createReadApiDocumentTool } from "./tools/read-api-document.js";
import { createReadEvidenceTool } from "./tools/read-evidence.js";
import type { ExecuteHttpInput, McpCallTrace, McpServerConfig, McpToolOutput, RegisteredApiDocument } from "./types.js";
import { McpToolCallError } from "./types.js";

const SAFE_ERROR = /^[A-Z][A-Z0-9_]{2,80}$/;

function errorCode(error: unknown): string {
  if (error instanceof Error && SAFE_ERROR.test(error.message)) return error.message;
  return "MCP_TOOL_CALL_FAILED";
}

function inputSummary(toolName: string, raw: unknown): Record<string, unknown> {
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (toolName === "execute_http") return {
    operationId: input.operationId,
    headerNames: Object.keys(input.headers && typeof input.headers === "object" ? input.headers : {}),
    queryNames: Object.keys(input.query && typeof input.query === "object" ? input.query : {}),
    pathParameterNames: Object.keys(input.pathParams && typeof input.pathParams === "object" ? input.pathParams : {}),
    bodyFields: Object.keys(input.body && typeof input.body === "object" ? input.body : {})
  };
  if (toolName === "read_evidence") return { artifactId: input.id };
  return { operationId: input.operationId ?? null };
}

function externalData(toolName: string, data: unknown): Record<string, unknown> {
  if (toolName !== "read_evidence") return data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : { result: data };
  const envelope = data as { ref?: { id?:string; kind?:string; sha256?:string; mediaType?:string; toolCallId?:string }; data?: unknown };
  const observation = envelope.data && typeof envelope.data === "object" ? envelope.data as Record<string, unknown> : {};
  const artifact = {
    artifactId: envelope.ref?.id ?? null,
    kind: envelope.ref?.kind ?? null,
    metadata: {
      sha256: envelope.ref?.sha256 ?? null,
      mediaType: envelope.ref?.mediaType ?? null,
      toolCallId: envelope.ref?.toolCallId ?? null
    }
  };
  if (envelope.ref?.kind !== "http_observation") return { ...artifact, data: envelope.data ?? null };
  return {
    ...artifact,
    request: observation.request ?? null,
    response: observation.response ?? null,
    statusCode: observation.statusCode ?? null,
    headers: observation.headers ?? null,
    durationMs: observation.durationMs ?? null
  };
}

export class McpApiBackend implements ToolBackend {
  readonly tools;
  readonly api: RegisteredApiDocument;
  constructor(readonly config: McpServerConfig, store: TrajectoryStore) {
    const parsed = describeOpenApiDocument(config.document);
    this.api = {
      id: `openapi-${digest(parsed.document).slice(0, 24)}`,
      document: parsed.document,
      description: parsed.description,
      operations: new Map(parsed.description.operations.map(operation => [operation.operationId, operation]))
    };
    this.tools = [
      createReadApiDocumentTool(this.api),
      createExecuteHttpTool(this.api, {
        allowedHosts: config.allowedHosts,
        allowedPorts: config.allowedPorts,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
        ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes })
      }),
      createReadEvidenceTool(store)
    ];
  }
  async describe(call: ToolInvocation): Promise<ApiActionDescriptor> {
    const environment = this.config.environment ?? "sandbox";
    if (call.name !== "execute_http") return { environment, workspace: "isolated", sideEffectFree: true, conditionalExecution: false, preconditions: { document: this.api.id } };
    const { operation, parsed } = requestForOperation(this.api, call.args as ExecuteHttpInput);
    return {
      environment,
      workspace: "isolated",
      sideEffectFree: operation.sideEffectFree,
      conditionalExecution: false,
      preconditions: { document: this.api.id },
      request: parsed.task.request,
      operation: {
        id: operation.operationId,
        path: operation.path,
        method: operation.method,
        risk: operation.method === "DELETE" ? "blocked" : operation.sideEffectFree ? "read" : "write",
        contractDigest: this.api.id,
        requiredScopes: []
      }
    };
  }
  async withActionLock(_call: ToolInvocation, action: () => Promise<ToolResult>): Promise<ToolResult> { return action(); }
  async verifyCurrentWorkspace(): Promise<boolean> { return true; }
}

export class McpToolRuntime {
  readonly store: TrajectoryStore;
  readonly backend: McpApiBackend;
  readonly registry: ToolRegistry;
  readonly workspace: ConvergentWorkspace;
  readonly guardrail: ApiGuardrail;
  readonly task: AgentTask;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(readonly config: McpServerConfig) {
    this.store = new TrajectoryStore(config.runFile);
    this.backend = new McpApiBackend(config, this.store);
    this.registry = new ToolRegistry(this.backend.tools);
    this.workspace = new ConvergentWorkspace(this.store, this.registry, 20);
    const environment = config.environment ?? "sandbox";
    this.task = {
      id: `mcp-${randomUUID()}`,
      goal: "Expose the registered API document, controlled HTTP execution, and persisted evidence through MCP.",
      taskFamily: "runtime-api",
      environment,
      inputArtifacts: [],
      allowedToolBundles: ["mcp-runtime-api", "shared"],
      risk: "low",
      budget: { maxModelCalls: 1, maxToolCalls: 10_000, maxTokens: 1, maxCostUsd: 1, maxDurationMs: 86_400_000 }
    };
    this.guardrail = new ApiGuardrail(this.store, this.registry, {
      policy: { hosts: config.allowedHosts, ports: config.allowedPorts, environments: [environment], credentialScopes: [] },
      policyVersion: "a-pidoc-mcp-1",
      describe: call => this.backend.describe(call),
      authorizeApproval: () => false,
      withActionLock: (call, action) => this.backend.withActionLock(call, action)
    });
  }

  static async create(config: McpServerConfig): Promise<McpToolRuntime> {
    const runtime = new McpToolRuntime(config);
    await runtime.store.create({
      formatVersion: 1,
      run: { runId: runtime.task.id, task: runtime.task, state: "running", steps: [], usage: { modelCalls: 0, toolCalls: 0, tokens: 0, estimatedCostUsd: 0 }, evidence: [] },
      messages: [], stateRevision: 0, workspaceRevision: 0, evidenceSequence: 0, elapsedMs: 0, artifacts: {}
    });
    return runtime;
  }

  invoke(toolName: string, args: unknown, protocolRequestId?: string, signal?: AbortSignal): Promise<McpToolOutput> {
    const run = () => this.invokeOne(toolName, args, protocolRequestId, signal);
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async invokeOne(toolName: string, args: unknown, protocolRequestId?: string, signal?: AbortSignal): Promise<McpToolOutput> {
    const callId = `mcp-${randomUUID()}`, call = { id: callId, name: toolName, args };
    const startTime = new Date().toISOString(), started = performance.now();
    let result: ToolResult | undefined, code: string | null = null;
    try {
      await this.store.transact(snapshot => {
        snapshot.run.usage.toolCalls++;
        appendStep(snapshot, "tool_call", { id: callId, name: toolName, args: redactValue(args), protocolRequestId });
      });
      // Reuse the registered parser to reject invalid client input before the
      // shared Guardrail classifies policy. Invalid input is not a policy event.
      if (toolName === "execute_http") requestForOperation(this.backend.api, args as ExecuteHttpInput);
      const stateBeforePreflight = await this.store.load();
      const preflight = await this.guardrail.preflight(call);
      if (preflight) {
        await this.recoverRejectedMcpCall(preflight.reason, stateBeforePreflight.run.state, stateBeforePreflight.stateRevision);
        throw new Error(preflight.reason);
      }
      result = await this.registry.execute(this.task, call, signal, (current, action) => this.guardrail.hooks().executeTool!(current, action));
      await this.store.transact(snapshot => appendStep(snapshot, "tool_result", { id: callId, name: toolName, result: { details: result }, isError: false }));
      await this.guardrail.hooks().afterTool?.(call, result, false, signal);
      await this.workspace.record(call, result, false);
      const artifactIds = result.evidence.map(ref => ref.id), data = externalData(toolName, result.data);
      const output: McpToolOutput = { callId, artifactId: artifactIds[0] ?? (typeof data.artifactId === "string" ? data.artifactId : null), artifactIds, ...data };
      await this.recordTrace({ type: "mcp_call_trace", toolName, callId, ...(protocolRequestId ? { protocolRequestId } : {}), startTime, endTime: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - started)), inputSummary: inputSummary(toolName, args), executionResult: "succeeded", httpStatus: typeof data.statusCode === "number" ? data.statusCode : null, generatedArtifactId: artifactIds[0] ?? null, artifactIds, errorCode: null });
      return output;
    } catch (error) {
      code = errorCode(error);
      await this.store.transact(snapshot => appendStep(snapshot, "tool_result", { id: callId, name: toolName, isError: true, errorCode: code }));
      const trace: McpCallTrace = { toolName, callId, ...(protocolRequestId ? { protocolRequestId } : {}), startTime, endTime: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - started)), inputSummary: inputSummary(toolName, args), executionResult: "failed", httpStatus: null, generatedArtifactId: null, artifactIds: [], errorCode: code, type: "mcp_call_trace" };
      await this.recordTrace(trace);
      throw new McpToolCallError({ callId, artifactId: null, artifactIds: [], errorCode: code, message: "The MCP tool call failed safely." });
    }
  }

  private async recordTrace(trace: McpCallTrace): Promise<void> {
    await this.store.transact(snapshot => appendStep(snapshot, "runtime", trace));
  }

  private async recoverRejectedMcpCall(reason: string, stateBeforePreflight: string, revisionBeforePreflight: number): Promise<void> {
    if (!new Set(["API_POLICY_BLOCKED", "API_ACTION_UNCLASSIFIABLE"]).has(reason)) return;
    if (stateBeforePreflight !== "running") return;
    await this.store.transact(snapshot => {
      const transition = snapshot.run.steps.at(-1);
      const transitionData = transition?.data as { state?: string; code?: string } | undefined;
      if (snapshot.stateRevision !== revisionBeforePreflight + 1 || snapshot.run.state !== "blocked" || snapshot.executionInDoubt || transition?.kind !== "state_transition" || transitionData?.state !== "blocked" || transitionData.code !== reason) return;
      snapshot.run.state = "running";
      appendStep(snapshot, "state_transition", { state: "running", code: "MCP_CALL_REJECTED_RECOVERED", rejectedCode: reason, previousBlockCode: reason });
    });
  }
}
