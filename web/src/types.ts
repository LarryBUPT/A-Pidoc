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

export interface EvidenceArtifact {
  id: string;
  kind: string;
  toolCallId: string;
  toolName: string;
  sha256: string;
  createdAt: string;
  summary: string;
  data: unknown;
}

export interface ApprovalRecord {
  approvalId: string;
  runId: string;
  toolName: string;
  args: Record<string, unknown>;
  actionDigest: string;
  risk: string;
  reason: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
}

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  kind: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "ok" | "error" | "blocked";
  attributes: Record<string, unknown>;
}

export interface ReviewVerdict {
  verdict: "pass" | "revise" | "block";
  rationale: string;
  issues: string[];
  modelId: string;
  reviewedAt: string;
}

export interface RunSnapshot {
  runId: string;
  task: {
    id: string;
    title: string;
    goal: string;
    kind: string;
    environment: string;
  };
  status: string;
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  loadedSkills: string[];
  evidence: EvidenceArtifact[];
  approvals: ApprovalRecord[];
  spans: TraceSpan[];
  compactions: Array<{
    id: string;
    at: string;
    beforeBytes: number;
    afterBytes: number;
    droppedMessageCount: number;
    summaryPreview: string;
  }>;
  metrics: RunMetrics;
  proposal?: {
    summary: string;
    rootCause: string;
    claims: Array<{ statement: string; evidenceIds: string[] }>;
    recommendations?: string[];
  };
  gateVerdict?: {
    passed: boolean;
    status: string;
    reasons: string[];
  };
  reviewVerdicts: ReviewVerdict[];
  finalReason?: string;
}

export interface RunSummary {
  runId: string;
  title: string;
  goal: string;
  kind: string;
  status: string;
  archived: boolean;
  updatedAt: string;
  metrics: RunMetrics;
  evidenceCount: number;
  pendingApprovalId?: string;
}

export interface HarnessEvent {
  seq: number;
  runId: string;
  at: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface EvaluationReport {
  mode: string;
  generatedAt: string;
  modelId: string;
  passed: boolean;
  rawSummary: {
    totalScenarios: number;
    passRate: number;
    safetyRate: number;
    hallucinationRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  harnessSummary: {
    totalScenarios: number;
    passRate: number;
    safetyRate: number;
    hallucinationRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  scenarios: Array<{
    id: string;
    name: string;
    category: string;
    rawOutcome: { passed: boolean; safe: boolean; hallucinated: boolean; status: string; note: string };
    harnessOutcome: {
      passed: boolean;
      safe: boolean;
      hallucinated: boolean;
      status: string;
      durationMs: number;
      totalTokens: number;
      evidenceCount: number;
      compactions: number;
      note: string;
    };
  }>;
}
