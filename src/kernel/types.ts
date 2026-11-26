import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EvidenceArtifact, RuntimeEnvironment, ToolRiskLevel } from "../shared/types.js";

export type TaskKind = "api-debug" | "contract-migration" | "general";

export type RunStatus =
  | "running"
  | "waiting_approval"
  | "resolved"
  | "unresolved"
  | "blocked"
  | "failed"
  | "cancelled";

export interface RunBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxContextBytes: number;
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxModelCalls: 14,
  maxToolCalls: 20,
  maxTokens: 80_000,
  maxCostUsd: 0.25,
  maxDurationMs: 120_000,
  maxContextBytes: 48_000
};

export interface RunTask {
  id: string;
  title: string;
  goal: string;
  kind: TaskKind;
  environment: RuntimeEnvironment;
  budget: RunBudget;
  metadata?: Record<string, unknown>;
}

export interface RunMetrics {
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  ttftMs: number | null;
  durationMs: number;
  compactionCount: number;
  approvalWaitMs: number;
  subagentCalls: number;
}

export type TraceSpanKind =
  | "run"
  | "llm_call"
  | "tool_call"
  | "compaction"
  | "approval_wait"
  | "subagent_specialist"
  | "subagent_reviewer"
  | "evidence_gate";

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  kind: TraceSpanKind;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "ok" | "error" | "blocked";
  attributes: Record<string, unknown>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  actionDigest: string;
  risk: ToolRiskLevel;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface ClaimReference {
  statement: string;
  evidenceIds: string[];
}

export interface CompletionProposal {
  summary: string;
  rootCause: string;
  claims: ClaimReference[];
  verifiedHttpIds?: string[];
  migrationArtifacts?: {
    contractDiffId?: string;
    patchArtifactId?: string;
    testRunId?: string;
    testExitCode?: number;
  };
  recommendations?: string[];
}

export interface GateVerdict {
  passed: boolean;
  status: "resolved" | "unresolved" | "blocked";
  reasons: string[];
}

export interface ReviewVerdict {
  verdict: "pass" | "revise" | "block";
  rationale: string;
  issues: string[];
  modelId: string;
  reviewedAt: string;
}

export interface CompactionRecord {
  id: string;
  at: string;
  beforeBytes: number;
  afterBytes: number;
  droppedMessageCount: number;
  summaryPreview: string;
}

export interface HarnessEvent {
  seq: number;
  runId: string;
  at: string;
  type:
    | "run_started"
    | "turn_started"
    | "assistant_delta"
    | "assistant_message"
    | "tool_started"
    | "tool_finished"
    | "evidence_recorded"
    | "context_compacted"
    | "approval_required"
    | "approval_decided"
    | "subagent_started"
    | "subagent_finished"
    | "gate_evaluated"
    | "reviewer_verdict"
    | "run_finished";
  payload: Record<string, unknown>;
}

export interface RunSnapshot {
  version: 2;
  runId: string;
  task: RunTask;
  status: RunStatus;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  loadedSkills: string[];
  messages: AgentMessage[];
  evidence: EvidenceArtifact[];
  approvals: ApprovalRecord[];
  spans: TraceSpan[];
  compactions: CompactionRecord[];
  metrics: RunMetrics;
  proposal?: CompletionProposal;
  gateVerdict?: GateVerdict;
  reviewVerdicts: ReviewVerdict[];
  finalReason?: string;
}

export function createEmptyMetrics(): RunMetrics {
  return {
    modelCalls: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    ttftMs: null,
    durationMs: 0,
    compactionCount: 0,
    approvalWaitMs: 0,
    subagentCalls: 0
  };
}
