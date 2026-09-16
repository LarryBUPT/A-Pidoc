import type { AgentTask, ApprovalGrant, ArtifactRef, EvidenceRef, HarnessTool, ToolContext } from "../harness/contracts.js";
export type DiagnosticStage = "symptom_confirmed" | "scope_narrowed" | "cause_supported" | "change_proposed" | "change_isolated" | "verification_passed" | "blocked";
export interface Hypothesis { id: string; claim: string; evidenceIds: string[]; missing: string[] }
export interface ApiDiagnosticState {
  stateRevision: number; workspaceRevision: number; evidenceSequence: number;
  stage: DiagnosticStage; confirmedFacts: EvidenceRef[]; openHypotheses: Hypothesis[];
  rejectedHypotheses: string[]; approvals: ApprovalGrant[]; noProgressCount: number;
}
export interface EvidencePackage {
  claimRefs: Array<{ claim: string; evidenceIds: string[] }>;
  contractDiffId?: string; httpObservationIds: string[]; patchArtifactId?: string;
  testRunId?: string; testExitCode?: number;
}
export interface EvidenceRequirement { kind: string; minCount: number }
export interface HostPolicy { hosts: string[]; ports: number[]; environments: AgentTask["environment"][]; credentialScopes: string[] }
export interface ApiHarnessEnvironment {
  id: string; version: string; apiContracts: ArtifactRef[]; hostPolicy: HostPolicy;
  tools(context: ToolContext): HarnessTool[];
  initialState(task: AgentTask): Promise<ApiDiagnosticState>;
  requiredEvidence(task: AgentTask): EvidenceRequirement[];
}
