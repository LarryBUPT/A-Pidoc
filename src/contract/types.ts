import type { DiscoveredApiCall, RepositoryTestRun } from "../repository/types.js";
import type { TraceEvent } from "../domain/types.js";

export type ContractChangeKind =
  | "OPERATION_ADDED"
  | "OPERATION_REMOVED"
  | "REQUEST_FIELD_ADDED"
  | "REQUEST_FIELD_REMOVED"
  | "REQUEST_FIELD_TYPE_CHANGED"
  | "REQUEST_FIELD_REQUIRED_CHANGED"
  | "RESPONSE_FIELD_ADDED"
  | "RESPONSE_FIELD_REMOVED"
  | "RESPONSE_FIELD_TYPE_CHANGED";

export interface ContractChange {
  id: string;
  kind: ContractChangeKind;
  severity: "high" | "medium" | "low";
  breaking: boolean;
  operation: string;
  location: "operation" | "request" | "response";
  fieldPath: string | null;
  before: unknown;
  after: unknown;
  rationale: string;
}

export interface ContractDiffReport {
  changes: ContractChange[];
  summary: { total: number; breaking: number; high: number; medium: number; low: number };
}

export interface ContractImpact {
  id: string;
  changeId: string;
  severity: ContractChange["severity"];
  reason: string;
  call: DiscoveredApiCall;
}

export interface ContractImpactReport {
  diff: ContractDiffReport;
  impacts: ContractImpact[];
  summary: { calls: number; impactedCalls: number; high: number; medium: number; low: number };
}

export interface MigrationPatchPlan {
  changeId: string;
  file: string;
  line: number;
  title: string;
  before: string;
  after: string;
  rationale: string;
  requiresApproval: true;
}

export interface ContractVerificationReport {
  sourceRoot: string;
  workspaceRoot: string;
  before: ContractImpactReport;
  after: ContractImpactReport;
  appliedPatches: MigrationPatchPlan[];
  writtenTests: string[];
  testRun: RepositoryTestRun;
  trace: TraceEvent[];
  passed: boolean;
}
