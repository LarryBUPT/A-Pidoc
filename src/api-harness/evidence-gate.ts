import type { EvidencePackage } from "./contracts.js";
import { resolveEvidence, workspaceState, type StoredEvidence } from "./convergent-workspace.js";
import { TrajectoryStore, appendStep, type RunSnapshot } from "../harness/trajectory-store.js";
import { digest } from "../harness/digest.js";
import { redactValue } from "../security/redaction.js";

export interface GateVerdict { status: "resolved" | "unresolved" | "blocked"; reasons: string[] }
export class EvidenceGate {
  constructor(readonly store: TrajectoryStore, private readonly verifyCurrentWorkspace?: (s: RunSnapshot, p: EvidencePackage) => Promise<boolean>) {}
  private check(s: RunSnapshot, p: EvidencePackage): GateVerdict {
    const reasons: string[] = [];
    if (s.run.state !== "running" || s.executionInDoubt) return { status: "blocked", reasons: ["RUN_NOT_COMPLETABLE"] };
    if (!p || !Array.isArray(p.claimRefs) || !Array.isArray(p.httpObservationIds) || p.claimRefs.length < 1 || p.claimRefs.length > 20) return { status: "unresolved", reasons: ["INVALID_EVIDENCE_PACKAGE"] };
    if (Object.keys(p).some(k => !["claimRefs", "httpObservationIds", "contractDiffId", "patchArtifactId", "testRunId", "testExitCode"].includes(k))) reasons.push("INVALID_EVIDENCE_PACKAGE");
    const get = (id: string | undefined, kind: string): StoredEvidence | undefined => { const a = id ? resolveEvidence(s, id) : undefined; if (!a || a.ref.kind !== kind) reasons.push(`MISSING_OR_INVALID_${kind.toUpperCase()}`); return a?.ref.kind === kind ? a : undefined; };
    for (const claim of p.claimRefs) if (!claim || typeof claim.claim !== "string" || !claim.claim.trim() || claim.claim.length > 500 || !Array.isArray(claim.evidenceIds) || !claim.evidenceIds.length || claim.evidenceIds.some(id => !resolveEvidence(s, id))) reasons.push("UNGROUNDED_CLAIM_REFERENCE");
    const requireApproval = (a: StoredEvidence | undefined): void => {
      if (!a) return;
      const id = a.ref.toolCallId;
      const call = s.run.steps.find(v => v.kind === "tool_call" && (v.data as { id?: string }).id === id)?.data as { args?: unknown } | undefined;
      const consumed = s.run.steps.find(v => v.kind === "approval" && (v.data as { type?: string; toolCallId?: string }).type === "consumed" && (v.data as { toolCallId?: string }).toolCallId === id);
      const g = consumed?.data as { normalizedArgsDigest?: string; runId?: string; environment?: string; workspaceRevision?: number; expiresAt?: string } | undefined;
      const confirmed = s.run.steps.some(v => v.kind === "approval" && (v.data as { type?: string; toolCallId?: string }).type === "execution_confirmed" && (v.data as { toolCallId?: string }).toolCallId === id);
      const expiry = Date.parse(g?.expiresAt ?? "");
      if (!call || !g || !confirmed || g.runId !== s.run.runId || g.environment !== s.run.task.environment || g.normalizedArgsDigest !== digest(call.args) || g.workspaceRevision !== a.beforeWorkspaceRevision || !Number.isFinite(expiry) || expiry <= Date.parse(consumed!.at)) reasons.push("MISSING_VALID_EXECUTION_APPROVAL");
    };
    if (s.run.task.taskFamily === "runtime-api") {
      const observations = p.httpObservationIds.map(id => get(id, "http_observation")).filter((a): a is StoredEvidence => !!a);
      const operations = s.run.evidence.filter(r => r.kind === "api_operation").map(r => resolveEvidence(s, r.id)).filter(Boolean);
      const before = observations.find(a => (a.data as { response?: { status?: number } }).response?.status! >= 400);
      const after = [...observations].reverse().find(a => { const status = (a.data as { response?: { status?: number } }).response?.status; return status !== undefined && status >= 200 && status < 300; });
      const beforeRequest = (before?.data as { request?: { url?: string } } | undefined)?.request;
      const afterRequest = (after?.data as { request?: { url?: string; method?: string } } | undefined)?.request;
      let targetMatches = false;
      if (beforeRequest?.url && afterRequest?.url) {
        const old = new URL(beforeRequest.url), next = new URL(afterRequest.url);
        targetMatches = old.origin === next.origin && old.pathname === next.pathname && operations.some(a => {
          const op = a!.data as { method?: string; path?: string; contractDigest?: string };
          return op.method === afterRequest.method && op.path === next.pathname && !!op.contractDigest;
        });
        const latest = s.run.evidence.filter(r => r.kind === "http_observation").map(r => resolveEvidence(s, r.id)).filter(a => {
          const url = (a?.data as { request?: { url?: string } } | undefined)?.request?.url;
          return url && new URL(url).origin === next.origin && new URL(url).pathname === next.pathname;
        }).at(-1);
        if (latest?.ref.id !== after?.ref.id) targetMatches = false;
      }
      if (!before || !after || before.ref.toolCallId === after.ref.toolCallId || before.sequence >= after.sequence || after.workspaceRevision !== s.workspaceRevision || !targetMatches) reasons.push("RUNTIME_REQUIRED_EVIDENCE_MISSING");
      for (const a of observations) if ((a.data as { sideEffect?: boolean }).sideEffect) requireApproval(a);
    } else if (s.run.task.taskFamily === "repository-contract") {
      const diff = get(p.contractDiffId, "contract_diff"), patch = get(p.patchArtifactId, "isolated_patch"), test = get(p.testRunId, "test_run");
      const impacts = s.run.evidence.filter(r => r.kind === "contract_impact").map(r => resolveEvidence(s, r.id)).filter(Boolean);
      const patchData = patch?.data as { applied?: boolean; isolated?: boolean; contractDiffId?: string } | undefined;
      const hasImpact = impacts.some(a => { const data = a!.data as { contractDiffId?: string; impacts?: unknown[] }; return data.contractDiffId === p.contractDiffId && !!data.impacts?.length; });
      if (!diff || !hasImpact || !patch || patchData?.applied !== true || patchData.isolated !== true || patchData.contractDiffId !== p.contractDiffId) reasons.push("MIGRATION_REQUIRED_EVIDENCE_MISSING");
      const actual = test?.data as { exitCode?: number; commandDigest?: string; testCount?: number; passed?: boolean } | undefined;
      if (!actual || actual.exitCode !== 0 || p.testExitCode !== actual.exitCode || !/^[a-f0-9]{64}$/.test(actual.commandDigest ?? "") || !Number.isSafeInteger(actual.testCount) || actual.testCount! < 1 || actual.passed !== true || test!.workspaceRevision !== s.workspaceRevision) reasons.push("VERIFICATION_NOT_PASSED");
      if (!patch || !test || patch.sequence >= test.sequence || (test.data as { patchArtifactId?: string }).patchArtifactId !== p.patchArtifactId) reasons.push("TEST_NOT_BOUND_TO_PATCH");
      requireApproval(patch); requireApproval(test);
    } else reasons.push("UNREGISTERED_TASK_FAMILY");
    return { status: reasons.length ? "unresolved" : "resolved", reasons: [...new Set(reasons)] };
  }
  private async assess(s: RunSnapshot, p: EvidencePackage): Promise<GateVerdict> {
    const verdict = this.check(s, p);
    if (s.run.task.taskFamily === "repository-contract" && verdict.status === "resolved" && (!this.verifyCurrentWorkspace || !await this.verifyCurrentWorkspace(s, p))) return { status: "unresolved", reasons: ["CURRENT_WORKSPACE_NOT_VERIFIED"] };
    return verdict;
  }
  async evaluate(p: EvidencePackage): Promise<GateVerdict> { try { return await this.assess(await this.store.load(), p); } catch { return { status: "unresolved", reasons: ["INVALID_EVIDENCE_PACKAGE"] }; } }
  async complete(p: EvidencePackage): Promise<GateVerdict> {
    const s = await this.store.load(); let verdict: GateVerdict;
    if (s.run.state === "resolved") {
      const ref = s.run.finalArtifact, saved = ref ? s.artifacts[ref.id] as { data?: unknown } | undefined : undefined;
      return ref && saved && digest(saved.data) === ref.sha256 && digest(redactValue(p)) === ref.sha256 ? { status: "resolved", reasons: [] } : { status: "blocked", reasons: ["FINAL_ARTIFACT_MISMATCH"] };
    }
    try { verdict = await this.assess(s, p); } catch { verdict = { status: "unresolved", reasons: ["INVALID_EVIDENCE_PACKAGE"] }; }
    await this.store.transact(v => {
      v.run.state = verdict.status; const state = workspaceState(v);
      if (verdict.status === "resolved") {
        state.stage = "verification_passed";
        const data = redactValue(p), ref = { id: `final-${v.run.runId}`, sha256: digest(data), mediaType: "application/json" };
        v.run.finalArtifact = ref; v.artifacts[ref.id] = { source: "completion", ref, data };
      }
      v.domainState = state; appendStep(v, "state_transition", { type: "evidence_gate", ...verdict, package: p });
    }, s.stateRevision);
    return verdict;
  }
}
