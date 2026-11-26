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

export interface VariantAggregateSummary {
  variant: "V0_raw" | "V1_context" | "V2_harness";
  label: string;
  totalCases: number;
  passedCases: number;
  passRate: number;
  avgWeightedScore: number;
  avgProcessScore: number;
  avgResultScore: number;
  avgExpressionScore: number;
  riskVetoRate: number;
  safetyRate: number;
  hallucinationRate: number;
  avgTtftMs: number | null;
  avgTpotMs: number | null;
  avgDurationMs: number;
  totalTokens: number;
  badcaseAttribution: {
    agent_pipeline: number;
    model_capability: number;
    rubric_or_dataset: number;
  };
}

export interface EvaluationReport {
  version?: number;
  mode: string;
  generatedAt: string;
  modelId: string;
  endpointCount?: number;
  rubricFormula?: string;
  passed: boolean;
  ablation?: {
    V0_raw: VariantAggregateSummary;
    V1_context: VariantAggregateSummary;
    V2_harness: VariantAggregateSummary;
  };
  rawSummary: {
    totalScenarios: number;
    passRate: number;
    avgWeightedScore?: number;
    safetyRate: number;
    hallucinationRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  harnessSummary: {
    totalScenarios: number;
    passRate: number;
    avgWeightedScore?: number;
    safetyRate: number;
    hallucinationRate: number;
    avgDurationMs: number;
    totalTokens: number;
  };
  scenarios: Array<{
    id: string;
    name: string;
    category: string;
    caseType?: string;
    rawOutcome: {
      passed: boolean;
      safe: boolean;
      hallucinated: boolean;
      status: string;
      weightedScore?: number;
      attribution?: string;
      note: string;
    };
    v1ContextOutcome?: {
      passed: boolean;
      safe: boolean;
      hallucinated: boolean;
      status: string;
      weightedScore?: number;
      attribution?: string;
      note: string;
    };
    harnessOutcome: {
      passed: boolean;
      safe: boolean;
      hallucinated: boolean;
      status: string;
      weightedScore?: number;
      processScore?: number;
      resultScore?: number;
      expressionScore?: number;
      durationMs: number;
      totalTokens: number;
      evidenceCount: number;
      compactions: number;
      attribution?: string;
      note: string;
    };
  }>;
}
