import type { ApprovalGrant, EvidenceRef, ToolResult } from "../harness/contracts.js";
import type { ApiDiagnosticState, Hypothesis } from "./contracts.js";
import type { ToolInvocation } from "../harness/pi-loop-adapter.js";
import { appendStep, TrajectoryStore, type RunSnapshot } from "../harness/trajectory-store.js";
import { ToolRegistry } from "../harness/tool-registry.js";
import { digest } from "../harness/digest.js";
import { redactValue } from "../security/redaction.js";

export interface StoredEvidence {
  ref: EvidenceRef; data: unknown; source: "tool"; beforeWorkspaceRevision: number;
  workspaceRevision: number; sequence: number;
}
interface WorkspaceState extends ApiDiagnosticState { factSignatures: string[] }
export function workspaceState(s: RunSnapshot): WorkspaceState {
  const previous = s.domainState as WorkspaceState | undefined;
  const grants = s.run.steps.filter(v => v.kind === "approval" && (v.data as { type?: string }).type === "consumed").map(v => v.data as ApprovalGrant);
  if (s.grant && !grants.some(g => g.grantId === s.grant!.grantId)) grants.push(s.grant);
  return { stage: "symptom_confirmed", confirmedFacts: [], openHypotheses: [], rejectedHypotheses: [], noProgressCount: 0, factSignatures: [], ...previous, approvals: grants, stateRevision: s.stateRevision, workspaceRevision: s.workspaceRevision, evidenceSequence: s.evidenceSequence };
}
export function resolveEvidence(s: RunSnapshot, id: string): StoredEvidence | undefined {
  const a = s.artifacts[id] as StoredEvidence | undefined;
  if (!a || a.source !== "tool" || a.ref.id !== id || digest(a.data) !== a.ref.sha256 || !s.run.evidence.some(r => r.id === id && r.sha256 === a.ref.sha256 && r.toolCallId === a.ref.toolCallId)) return undefined;
  const call = s.run.steps.find(v => v.kind === "tool_call" && (v.data as { id?: string }).id === a.ref.toolCallId);
  const result = s.run.steps.find(v => v.kind === "tool_result" && (v.data as { id?: string }).id === a.ref.toolCallId);
  const resultData = result?.data as { isError?: boolean; result?: { details?: ToolResult } } | undefined;
  if (!call || !resultData || resultData.isError || resultData.result?.details?.success !== true || digest(resultData.result.details.data) !== a.ref.sha256) return undefined;
  return a;
}
export class ConvergentWorkspace {
  constructor(readonly store: TrajectoryStore, readonly registry: ToolRegistry, private readonly noProgressLimit = 3) {}
  async record(call: ToolInvocation, raw: unknown, isError: boolean): Promise<void> {
    const tool = this.registry.get(call.name); if (!tool) throw new Error("UNKNOWN_EVIDENCE_TOOL");
    await this.store.transact(s => {
      const state = workspaceState(s), result = raw as ToolResult | undefined;
      let progress = false;
      if (!isError && result?.success === true && result.redacted === true && Array.isArray(result.evidence)) {
        const data = redactValue(result.data), hash = digest(data);
        if (result.evidence.length > 8) throw new Error("EVIDENCE_OUTPUT_LIMIT");
        const beforeRevision = s.workspaceRevision;
        if (result.controlPlaneChanged) {
          if (tool.risk !== "write" && tool.risk !== "publish") throw new Error("UNTRUSTED_CONTROL_MUTATION");
          s.workspaceRevision++;
        }
        for (const ref of result.evidence) {
          if (!tool.evidenceKinds?.includes(ref.kind) || ref.sha256 !== hash || ref.toolCallId !== call.id || !/^[A-Za-z0-9_.:-]{1,160}$/.test(ref.id) || ref.mediaType !== "application/json") throw new Error("INVALID_TOOL_EVIDENCE");
          const existing = s.artifacts[ref.id] as StoredEvidence | undefined;
          if (existing) { if (existing.ref.sha256 !== hash || existing.ref.toolCallId !== call.id) throw new Error("EVIDENCE_ID_COLLISION"); continue; }
          const signature = `${ref.kind}:${hash}`;
          if (!state.factSignatures.includes(signature)) { state.factSignatures.push(signature); progress = true; }
          s.evidenceSequence++;
          s.artifacts[ref.id] = { ref: structuredClone(ref), data, source: "tool", beforeWorkspaceRevision: beforeRevision, workspaceRevision: s.workspaceRevision, sequence: s.evidenceSequence } satisfies StoredEvidence;
          s.run.evidence.push(structuredClone(ref)); state.confirmedFacts.push(structuredClone(ref));
        }
      }
      state.noProgressCount = progress ? 0 : state.noProgressCount + 1;
      const artifacts = state.confirmedFacts.map(r => s.artifacts[r.id] as StoredEvidence);
      const kinds = new Set(artifacts.map(a => a.ref.kind));
      const latestTest = [...artifacts].reverse().find(a => a.ref.kind === "test_run");
      if (kinds.has("isolated_patch")) state.stage = "change_isolated";
      else if (kinds.has("patch_proposal")) state.stage = "change_proposed";
      else if (kinds.has("contract_diff") || kinds.has("api_operation")) state.stage = "scope_narrowed";
      if (latestTest && (latestTest.data as { exitCode?: number }).exitCode !== 0) state.stage = "scope_narrowed";
      if (s.run.state === "resolved") state.stage = "verification_passed";
      if (s.run.state === "blocked" || s.run.state === "failed") state.stage = "blocked";
      // Only EvidenceGate can grant verification_passed/resolved.
      if (state.noProgressCount >= this.noProgressLimit && s.run.state === "running") { s.run.state = "blocked"; state.stage = "blocked"; appendStep(s, "state_transition", { code: "NO_PROGRESS_LIMIT" }); }
      state.stateRevision = s.stateRevision + 1; state.workspaceRevision = s.workspaceRevision; state.evidenceSequence = s.evidenceSequence;
      s.domainState = state; appendStep(s, "runtime", { type: "workspace_reduced", stage: state.stage, evidenceSequence: s.evidenceSequence, workspaceRevision: s.workspaceRevision, noProgressCount: state.noProgressCount });
    });
  }
  async hypothesize(hypothesis: Hypothesis): Promise<void> {
    await this.store.transact(s => {
      const state = workspaceState(s);
      if (!hypothesis.id || hypothesis.id.length > 128 || !hypothesis.claim.trim() || hypothesis.claim.length > 500 || hypothesis.evidenceIds.some(id => !resolveEvidence(s, id)) || hypothesis.missing.length > 8 || hypothesis.missing.some(v => v.length > 200) || state.openHypotheses.length >= 8) throw new Error("INVALID_HYPOTHESIS");
      state.openHypotheses.push(redactValue(hypothesis) as Hypothesis); s.domainState = state;
    });
  }
  async controlChanged(): Promise<void> { await this.store.transact(s => { s.workspaceRevision++; appendStep(s, "runtime", { type: "control_plane_changed", workspaceRevision: s.workspaceRevision }); }); }
  async view(): Promise<ApiDiagnosticState> { return workspaceState(await this.store.load()); }
}
