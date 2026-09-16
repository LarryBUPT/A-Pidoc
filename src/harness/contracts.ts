// API tools depend on these contracts, never on Pi event/message types.
export type Environment = "sandbox" | "staging" | "production";
export type RunState = "queued" | "running" | "waiting_approval" | "approval_granted_pending_reissue" | "reviewing" | "resolved" | "unresolved" | "blocked" | "failed";
export interface ArtifactRef { id: string; sha256: string; mediaType: string }
export interface EvidenceRef extends ArtifactRef { kind: string; toolCallId: string }
export interface RunBudget { maxModelCalls: number; maxToolCalls: number; maxTokens: number; maxCostUsd: number; maxDurationMs: number }
export interface RunUsage { modelCalls: number; toolCalls: number; tokens: number; estimatedCostUsd: number }
export interface AgentTask {
  id: string; goal: string; taskFamily: string; environment: Environment;
  tenantId?: string; workspace?: ArtifactRef; inputArtifacts: ArtifactRef[];
  allowedToolBundles: string[]; risk: "low" | "medium" | "high"; budget: RunBudget;
}
export interface ToolConcurrencyPolicy {
  parallelSafe: boolean; sideEffectFree: boolean; snapshotConsistent: boolean;
  resourceKey?: string; maxConcurrency?: number;
}
export interface ToolContext { runId: string; toolCallId: string; environment: Environment; signal?: AbortSignal }
export interface ToolResult<Output = unknown> {
  success: boolean; data: Output; evidence: EvidenceRef[]; warnings: string[];
  durationMs: number; redacted: true;
  controlPlaneChanged?: boolean;
}
export interface HarnessTool<Input = unknown, Output = unknown> {
  name: string; bundle: string; description: string; inputSchema: Record<string, unknown>;
  risk: "read" | "network" | "write" | "publish"; executionMode: "parallel" | "sequential";
  idempotency: "safe" | "keyed" | "unsafe"; concurrency: ToolConcurrencyPolicy;
  evidenceKinds?: string[];
  execute(input: Input, context: ToolContext): Promise<ToolResult<Output>>;
}
export type PolicyDecision =
  | { decision: "allow"; reason: string }
  | { decision: "require_approval"; reason: string; approvalId: string }
  | { decision: "block"; reason: string };
export interface PendingApproval {
  approvalId: string; runId: string; toolName: string; normalizedArgsDigest: string;
  environment: Environment; workspaceRevision: number; preconditionDigest: string;
  reentryAttempts: number; expiresAt: string;
  status: "pending" | "granted" | "denied" | "expired" | "invalidated" | "consumed";
}
export interface ApprovalGrant {
  grantId: string; approvalId: string; runId: string; toolName: string;
  normalizedArgsDigest: string; environment: Environment; workspaceRevision: number;
  preconditionDigest: string; approvedBy: string; source: string; expiresAt: string;
  status: "granted" | "invalidated" | "consumed";
}
export interface ApprovalRequiredPayload {
  code: "APPROVAL_REQUIRED"; approvalId: string; runId: string; toolName: string;
  actionDigest: string; instruction: "STOP_AND_WAIT";
}
export interface ApprovalGrantedMessage {
  type: "approval_granted"; approvalId: string; runId: string; actionDigest: string;
  toolName: string; instruction: "REISSUE_EXACT_TOOL_CALL";
}
export interface TrajectoryStep {
  seq: number; at: string;
  kind: "model_turn" | "tool_call" | "tool_result" | "policy" | "approval" | "review" | "state_transition" | "reentry" | "runtime";
  data: unknown;
}
export interface AgentRun {
  runId: string; task: AgentTask; state: RunState; steps: TrajectoryStep[];
  usage: RunUsage; evidence: EvidenceRef[]; finalArtifact?: ArtifactRef;
}
