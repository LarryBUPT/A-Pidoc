import { randomUUID } from "node:crypto";
import type { AgentTask, ApprovalGrant, ApprovalGrantedMessage, ApprovalRequiredPayload, Environment } from "./contracts.js";
import type { PiLoopAdapter, ToolInvocation } from "./pi-loop-adapter.js";
import { appendStep, TrajectoryStore, type RunSnapshot } from "./trajectory-store.js";
import { digest } from "./digest.js";
import { redactValue } from "../security/redaction.js";

export interface ApprovalIdentity { actorId: string; source: string; tenantId?: string }
export interface ActionBinding { environment: Environment; workspaceRevision: number; preconditionDigest: string }
export function convertApprovalMessages(messages: unknown[]) {
  return messages.flatMap((raw): import("@earendil-works/pi-ai").Message[] => {
    if (!raw || typeof raw !== "object") return [];
    const m = raw as Record<string, unknown>;
    if (m.role === "approval_granted" && m.instruction === "REISSUE_EXACT_TOOL_CALL") {
      return [{ role: "user", timestamp: Number(m.timestamp), content: `Action digest ${m.actionDigest} is authorized for tool ${m.toolName}. You MUST re-issue the exact same tool call now to proceed. REISSUE_EXACT_TOOL_CALL. Safe original arguments: ${JSON.stringify(m.args)}. A natural-language acknowledgment is not execution. ${m.correction ? "This is the only correction turn." : ""}` }];
    }
    return ["user", "assistant", "toolResult"].includes(String(m.role)) ? [raw as import("@earendil-works/pi-ai").Message] : [];
  });
}
export class ApprovalProtocol {
  constructor(readonly store: TrajectoryStore, private readonly authorize: (identity: ApprovalIdentity, task: AgentTask) => boolean, private readonly now = () => Date.now()) {}
  async suspend(call: ToolInvocation, binding: ActionBinding): Promise<ApprovalRequiredPayload> {
    if (digest(call.args) !== digest(redactValue(call.args))) throw new Error("SENSITIVE_APPROVAL_ARGUMENTS");
    const id = randomUUID(), actionDigest = digest(call.args);
    await this.store.transact(s => {
      if (s.run.state !== "running" || s.executionInDoubt) throw new Error("INVALID_SUSPENSION_STATE");
      s.pendingApproval = { approvalId: id, runId: s.run.runId, toolName: call.name, normalizedArgsDigest: actionDigest, ...binding, reentryAttempts: 0, status: "pending", expiresAt: new Date(this.now() + 15 * 60_000).toISOString() };
      delete s.grant; s.approvedArgs = structuredClone(call.args);
      appendStep(s, "policy", { decision: "require_approval", toolCallId: call.id, approvalId: id, actionDigest });
      appendStep(s, "approval", { type: "pending", approvalId: id, toolName: call.name, actionDigest });
      s.run.state = "waiting_approval"; appendStep(s, "state_transition", { state: "waiting_approval" });
    });
    const s = await this.store.load();
    return { code: "APPROVAL_REQUIRED", approvalId: id, runId: s.run.runId, toolName: call.name, actionDigest, instruction: "STOP_AND_WAIT" };
  }
  private matches(s: RunSnapshot, call: ToolInvocation, binding: ActionBinding): boolean {
    const p = s.pendingApproval, g = s.grant;
    return !!p && !!g && p.status === "granted" && g.status === "granted" && p.approvalId === g.approvalId && p.runId === s.run.runId && g.runId === s.run.runId && p.toolName === call.name && g.toolName === call.name && p.normalizedArgsDigest === digest(call.args) && g.normalizedArgsDigest === p.normalizedArgsDigest && g.environment === binding.environment && p.environment === binding.environment && g.workspaceRevision === binding.workspaceRevision && p.workspaceRevision === binding.workspaceRevision && g.preconditionDigest === binding.preconditionDigest && p.preconditionDigest === binding.preconditionDigest && Date.parse(g.expiresAt) > this.now() && Date.parse(p.expiresAt) > this.now();
  }
  async grant(approvalId: string, identity: ApprovalIdentity, binding: ActionBinding): Promise<ApprovalGrant> {
    const s = await this.store.load();
    if (!identity.actorId.trim() || !identity.source.trim() || !this.authorize(identity, s.run.task)) throw new Error("APPROVAL_AUTHORITY_DENIED");
    if (s.run.task.tenantId !== identity.tenantId) throw new Error("APPROVAL_TENANT_DENIED");
    const result = await this.store.transact(v => {
      const p = v.pendingApproval;
      if (v.run.state !== "waiting_approval" || !p || p.status !== "pending" || p.approvalId !== approvalId || p.runId !== v.run.runId || p.environment !== binding.environment || p.workspaceRevision !== binding.workspaceRevision || p.preconditionDigest !== binding.preconditionDigest || Date.parse(p.expiresAt) <= this.now()) throw new Error("APPROVAL_SCOPE_INVALID");
      p.status = "granted";
      v.grant = { grantId: randomUUID(), approvalId, runId: p.runId, toolName: p.toolName, normalizedArgsDigest: p.normalizedArgsDigest, environment: p.environment, workspaceRevision: p.workspaceRevision, preconditionDigest: p.preconditionDigest, approvedBy: identity.actorId, source: identity.source, expiresAt: p.expiresAt, status: "granted" };
      appendStep(v, "approval", { type: "granted", ...v.grant });
    }, s.stateRevision);
    return result.grant!;
  }
  async block(code: string, status: "denied" | "expired" | "invalidated" = "invalidated"): Promise<void> {
    await this.store.transact(s => { if (s.pendingApproval && s.pendingApproval.status !== "consumed") s.pendingApproval.status = status; if (s.grant && s.grant.status !== "consumed") s.grant.status = "invalidated"; s.run.state = "blocked"; appendStep(s, "policy", { decision: "block", code }); appendStep(s, "state_transition", { state: "blocked", code }); });
  }
  async deny(approvalId: string, identity: ApprovalIdentity): Promise<void> {
    const s = await this.store.load();
    if (!this.authorize(identity, s.run.task) || identity.tenantId !== s.run.task.tenantId || s.run.state !== "waiting_approval" || s.pendingApproval?.approvalId !== approvalId) throw new Error("APPROVAL_AUTHORITY_DENIED");
    await this.block("APPROVAL_DENIED", "denied");
  }
  async consume(call: ToolInvocation, binding: ActionBinding): Promise<boolean> {
    const s = await this.store.load();
    if (s.run.state !== "approval_granted_pending_reissue" || !this.matches(s, call, binding)) { await this.block("APPROVAL_REENTRY_SCOPE_INVALID"); return false; }
    await this.store.transact(v => {
      if (v.run.state !== "approval_granted_pending_reissue" || !this.matches(v, call, binding)) throw new Error("APPROVAL_CAS_FAILED");
      v.pendingApproval!.status = "consumed"; v.grant!.status = "consumed";
      v.executionInDoubt = { toolCallId: call.id, actionDigest: digest(call.args) };
      v.run.state = "running";
      appendStep(v, "approval", { type: "consumed", toolCallId: call.id, ...v.grant });
      appendStep(v, "policy", { decision: "allow", toolCallId: call.id, actionDigest: digest(call.args) });
    }, s.stateRevision);
    return true;
  }
  async outcome(call: ToolInvocation, isError: boolean): Promise<void> {
    const s = await this.store.load(); if (s.executionInDoubt?.toolCallId !== call.id) return;
    await this.store.transact(v => {
      if (v.executionInDoubt?.toolCallId !== call.id) throw new Error("OUTCOME_SCOPE_INVALID");
      if (isError) { v.run.state = "blocked"; appendStep(v, "approval", { type: "execution_in_doubt", toolCallId: call.id }); }
      else { delete v.executionInDoubt; appendStep(v, "approval", { type: "execution_confirmed", toolCallId: call.id, actionDigest: digest(call.args) }); }
    }, s.stateRevision);
  }
  async resume(adapter: PiLoopAdapter, binding: () => Promise<ActionBinding>): Promise<RunSnapshot> {
    for (;;) {
      const s = await this.store.load(), p = s.pendingApproval;
      if (!["waiting_approval", "approval_granted_pending_reissue"].includes(s.run.state)) return s;
      if (p && Date.parse(p.expiresAt) <= this.now()) { await this.block("APPROVAL_EXPIRED", "expired"); return this.store.load(); }
      if (s.run.state === "waiting_approval" && p?.status === "pending" && !s.grant) return s;
      if (!p || !s.grant || !this.matches(s, { id: "resume", name: p.toolName, args: s.approvedArgs }, await binding())) { await this.block("APPROVAL_RESUME_SCOPE_INVALID"); return this.store.load(); }
      const b = s.run.task.budget, u = s.run.usage;
      if (p.reentryAttempts >= 2 || u.modelCalls >= b.maxModelCalls || u.tokens >= b.maxTokens || u.estimatedCostUsd >= b.maxCostUsd || s.elapsedMs >= b.maxDurationMs) { await this.block("APPROVAL_REENTRY_FAILED"); return this.store.load(); }
      await this.store.transact(v => {
        const pending = v.pendingApproval!; pending.reentryAttempts++;
        v.run.state = "approval_granted_pending_reissue";
        const message: ApprovalGrantedMessage = { type: "approval_granted", approvalId: pending.approvalId, runId: v.run.runId, actionDigest: pending.normalizedArgsDigest, toolName: pending.toolName, instruction: "REISSUE_EXACT_TOOL_CALL" };
        v.messages.push({ role: "approval_granted", ...message, timestamp: this.now(), args: v.approvedArgs, correction: pending.reentryAttempts === 2 });
        appendStep(v, "reentry", { attempt: pending.reentryAttempts, approvalId: pending.approvalId });
      }, s.stateRevision);
      const result = await adapter.continue();
      if (result.run.state !== "approval_granted_pending_reissue") return result;
    }
  }
}
