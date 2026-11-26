import { sha256Digest } from "../shared/digest.js";
import type { EvidenceArtifact } from "../shared/types.js";
import type { CompletionProposal, GateVerdict, RunSnapshot } from "./types.js";

/**
 * 硬证据门禁（Deterministic Evidence Gate）：
 * 防止 LLM“口头宣称修复成功”的幻觉问题。
 * 所有结论声明必须锚定到当前 Run 真实执行工具产生的 SHA-256 完整性证据。
 */
export class EvidenceGate {
  verifyEvidenceIntegrity(artifact: EvidenceArtifact): boolean {
    return sha256Digest(artifact.data) === artifact.sha256;
  }

  evaluate(snapshot: RunSnapshot, proposal: CompletionProposal): GateVerdict {
    const reasons: string[] = [];

    if (!proposal.summary.trim() || !proposal.rootCause.trim()) {
      reasons.push("MISSING_SUMMARY_OR_ROOT_CAUSE");
    }

    if (!Array.isArray(proposal.claims) || proposal.claims.length === 0) {
      reasons.push("MISSING_GROUNDED_CLAIMS");
    }

    const evidenceById = new Map<string, EvidenceArtifact>();
    for (const item of snapshot.evidence) {
      if (this.verifyEvidenceIntegrity(item)) {
        evidenceById.set(item.id, item);
      }
    }

    // 1. 校验每条结论是否引用了真实且未被篡改的 Evidence Artifact
    for (const claim of proposal.claims ?? []) {
      if (!claim.statement.trim() || !claim.evidenceIds.length) {
        reasons.push("CLAIM_WITHOUT_EVIDENCE_ID");
        continue;
      }
      for (const evidenceId of claim.evidenceIds) {
        if (!evidenceById.has(evidenceId)) {
          reasons.push(`INVALID_EVIDENCE_REF:${evidenceId}`);
        }
      }
    }

    // 2. api-debug 任务的专属完成合同：必须存在真实 HTTP 观测，若声称验证修复则最新观测必须为 2xx
    if (snapshot.task.kind === "api-debug") {
      const httpIds = proposal.verifiedHttpIds ?? [];
      const httpArtifacts = httpIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is EvidenceArtifact => !!item && item.kind === "http_observation");

      if (httpArtifacts.length === 0) {
        reasons.push("API_DEBUG_MISSING_HTTP_OBSERVATION");
      } else {
        const latest = httpArtifacts.at(-1)!;
        const responseStatus = (latest.data as { response?: { status?: number } })?.response?.status;
        if (typeof responseStatus !== "number" || responseStatus < 200 || responseStatus >= 300) {
          reasons.push(`LATEST_HTTP_OBSERVATION_NOT_2XX:${String(responseStatus)}`);
        }
      }
    }

    // 3. contract-migration 任务的专属完成合同：必须提供 diff + 隔离补丁 + 通过的测试运行记录
    if (snapshot.task.kind === "contract-migration") {
      const migration = proposal.migrationArtifacts;
      const diffArtifact = migration?.contractDiffId
        ? evidenceById.get(migration.contractDiffId)
        : undefined;
      const patchArtifact = migration?.patchArtifactId
        ? evidenceById.get(migration.patchArtifactId)
        : undefined;
      const testArtifact = migration?.testRunId
        ? evidenceById.get(migration.testRunId)
        : undefined;

      if (!diffArtifact || diffArtifact.kind !== "contract_diff") {
        reasons.push("MIGRATION_MISSING_CONTRACT_DIFF");
      }
      if (!patchArtifact || patchArtifact.kind !== "isolated_patch") {
        reasons.push("MIGRATION_MISSING_ISOLATED_PATCH");
      }
      if (!testArtifact || testArtifact.kind !== "test_run") {
        reasons.push("MIGRATION_MISSING_TEST_RUN");
      } else {
        const testData = testArtifact.data as { exitCode?: number; passed?: boolean };
        if (testData.exitCode !== 0 || testData.passed !== true || migration?.testExitCode !== 0) {
          reasons.push("MIGRATION_REGRESSION_TESTS_NOT_PASSED");
        }
      }

      // 确认写操作工具经过了真实人工审批消费
      const consumedApprovals = snapshot.approvals.filter((item) => item.status === "consumed");
      if (consumedApprovals.length === 0) {
        reasons.push("MIGRATION_MISSING_CONSUMED_APPROVAL");
      }
    }

    const uniqueReasons = [...new Set(reasons)];
    return {
      passed: uniqueReasons.length === 0,
      status: uniqueReasons.length === 0 ? "resolved" : "unresolved",
      reasons: uniqueReasons
    };
  }
}
