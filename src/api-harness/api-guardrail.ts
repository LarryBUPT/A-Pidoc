import type { AgentTask, Environment, ToolResult } from "../harness/contracts.js";
import type { ApiRequest } from "../domain/types.js";
import type { HostPolicy } from "./contracts.js";
import type { LoopHooks, ToolInvocation, PiLoopAdapter } from "../harness/pi-loop-adapter.js";
import { ApprovalProtocol, convertApprovalMessages, type ApprovalIdentity, type ActionBinding } from "../harness/approval-protocol.js";
import { appendStep, TrajectoryStore } from "../harness/trajectory-store.js";
import { ToolRegistry } from "../harness/tool-registry.js";
import { digest } from "../harness/digest.js";
import { redactValue } from "../security/redaction.js";
import { RequestPolicy } from "../security/request-policy.js";

export interface ApiActionDescriptor {
  environment: Environment; tenantId?: string; workspace: "original" | "isolated";
  sideEffectFree: boolean; conditionalExecution: boolean;
  preconditions: Record<string, string>; request?: ApiRequest;
  operation?: { id: string; path: string; method: string; risk: "read" | "write" | "blocked"; contractDigest: string; requiredScopes: string[] };
}
export interface ApiGuardrailOptions {
  policy: HostPolicy; policyVersion: string;
  describe: (call: ToolInvocation) => Promise<ApiActionDescriptor>;
  authorizeApproval: (identity: ApprovalIdentity, task: AgentTask) => boolean;
  withActionLock?: (call: ToolInvocation, action: () => Promise<ToolResult>) => Promise<ToolResult>;
  resolveHost?: (host: string) => Promise<string[]>; now?: () => number;
}
export class ApiGuardrail {
  readonly approvals: ApprovalProtocol;
  private readonly requestPolicy: RequestPolicy;
  constructor(readonly store: TrajectoryStore, readonly registry: ToolRegistry, private readonly options: ApiGuardrailOptions) {
    this.approvals = new ApprovalProtocol(store, options.authorizeApproval, options.now);
    this.requestPolicy = new RequestPolicy({ allowedHosts: options.policy.hosts, allowedPorts: options.policy.ports, ...(options.resolveHost ? { resolveHost: options.resolveHost } : {}) });
  }
  private async classify(call: ToolInvocation): Promise<{ risk: "allow" | "approval" | "block"; binding: ActionBinding }> {
    const s = await this.store.load(), t = this.registry.get(call.name), d = await this.options.describe(call);
    if (!t) throw new Error("UNKNOWN_TOOL");
    const binding = { environment: d.environment, workspaceRevision: s.workspaceRevision, preconditionDigest: digest({ toolSchema: t.inputSchema, policyVersion: this.options.policyVersion, hostPolicy: this.options.policy, preconditions: d.preconditions, operation: d.operation ?? null, environment: d.environment, tenantId: d.tenantId ?? null, sideEffectFree: d.sideEffectFree, conditionalExecution: d.conditionalExecution, workspace: d.workspace }) };
    if (d.environment !== s.run.task.environment || !this.options.policy.environments.includes(d.environment) || d.tenantId !== s.run.task.tenantId || digest(call.args) !== digest(redactValue(call.args))) return { risk: "block", binding };
    if (t.risk === "network") {
      const r = d.request, op = d.operation;
      if (!r || !op || !op.contractDigest || !op.id || op.method.toUpperCase() !== r.method || op.risk === "blocked" || r.method === "DELETE" || !op.requiredScopes.every(scope => this.options.policy.credentialScopes.includes(scope))) return { risk: "block", binding };
      // Operation resolver is a trusted backend; still verify concrete path.
      const actual = new URL(r.url); const pattern = op.path.split("/").map(part => part.startsWith("{") && part.endsWith("}") ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
      if (!new RegExp(`^${pattern}$`).test(actual.pathname) || actual.hostname === "169.254.169.254") return { risk: "block", binding };
      try { await this.requestPolicy.assertResolvedAddressAllowed(r); } catch { return { risk: "block", binding }; }
      if (op.risk === "read" && d.sideEffectFree) return { risk: "allow", binding };
    } else if (t.risk === "read" && d.sideEffectFree) return { risk: "allow", binding };
    if (d.environment === "production" || d.workspace !== "isolated" || !d.conditionalExecution || !this.options.withActionLock) return { risk: "block", binding };
    return { risk: "approval", binding };
  }
  async preflight(call: ToolInvocation) {
    const s = await this.store.load();
    if (s.run.state === "waiting_approval") return { block: true as const, terminate: true as const, reason: "RUN_SUSPENDED" };
    let result: Awaited<ReturnType<ApiGuardrail["classify"]>>;
    try { result = await this.classify(call); } catch { await this.approvals.block("API_ACTION_UNCLASSIFIABLE"); return { block: true as const, terminate: true as const, reason: "API_ACTION_UNCLASSIFIABLE" }; }
    if (result.risk === "block") { await this.approvals.block("API_POLICY_BLOCKED"); return { block: true as const, terminate: true as const, reason: "API_POLICY_BLOCKED" }; }
    if (s.run.state === "approval_granted_pending_reissue") {
      const allowed = await this.approvals.consume(call, result.binding);
      return allowed ? undefined : { block: true as const, terminate: true as const, reason: "APPROVAL_REENTRY_SCOPE_INVALID" };
    }
    if (s.run.state !== "running") return { block: true as const, terminate: true as const, reason: "RUN_INACTIVE" };
    if (result.risk === "approval") {
      const payload = await this.approvals.suspend(call, result.binding);
      return { block: true as const, terminate: true as const, reason: JSON.stringify(payload) };
    }
    await this.store.transact(v => appendStep(v, "policy", { decision: "allow", toolCallId: call.id, preconditionDigest: result.binding.preconditionDigest }));
    return undefined;
  }
  private async originalBinding(): Promise<ActionBinding> {
    const s = await this.store.load(); if (!s.pendingApproval) throw new Error("NO_PENDING_APPROVAL");
    const result = await this.classify({ id: "approval", name: s.pendingApproval.toolName, args: s.approvedArgs });
    if (result.risk === "block") throw new Error("APPROVAL_DOMAIN_POLICY_CHANGED");
    return result.binding;
  }
  async grant(approvalId: string, identity: ApprovalIdentity) { return this.approvals.grant(approvalId, identity, await this.originalBinding()); }
  async resume(adapter: PiLoopAdapter) {
    try { return await this.approvals.resume(adapter, () => this.originalBinding()); }
    catch { await this.approvals.block("APPROVAL_RESUME_INVALID"); return this.store.load(); }
  }
  private async execute(call: ToolInvocation, action: () => Promise<ToolResult>): Promise<ToolResult> {
    const result = await this.classify(call), state = await this.store.load();
    if (state.run.state !== "running") throw new Error("EXECUTION_RUN_INACTIVE");
    if (result.risk === "allow" && !state.executionInDoubt) return action();
    if (result.risk === "allow" && state.executionInDoubt) throw new Error("EXECUTION_POLICY_CHANGED");
    if (result.risk === "block" || !this.options.withActionLock) throw new Error("EXECUTION_POLICY_CHANGED");
    return this.options.withActionLock(call, async () => {
      const fresh = await this.classify(call), s = await this.store.load(), g = s.grant;
      if (fresh.risk !== "approval" || s.run.state !== "running" || s.executionInDoubt?.toolCallId !== call.id || !g || g.status !== "consumed" || g.normalizedArgsDigest !== digest(call.args) || g.toolName !== call.name || g.environment !== fresh.binding.environment || g.workspaceRevision !== fresh.binding.workspaceRevision || g.preconditionDigest !== fresh.binding.preconditionDigest || Date.parse(g.expiresAt) <= (this.options.now?.() ?? Date.now())) throw new Error("EXECUTION_PRECONDITION_CHANGED");
      return action();
    });
  }
  hooks(): LoopHooks {
    return {
      executeTool: (call, action) => this.execute(call, action),
      beforeTool: call => this.preflight(call),
      afterTool: (call, _result, isError) => this.approvals.outcome(call, isError),
      convert: convertApprovalMessages,
      shouldStop: async () => ["waiting_approval", "approval_granted_pending_reissue", "blocked", "failed"].includes((await this.store.load()).run.state),
      onEvent: async event => {
        if (event.type === "tool_execution_end" && event.isError && (await this.store.load()).run.state === "approval_granted_pending_reissue") await this.approvals.block("APPROVAL_REENTRY_INVALID_TOOL");
      }
    };
  }
}
