import { randomUUID } from "node:crypto";
import { sha256Digest } from "../shared/digest.js";
import { redactValue } from "../shared/redaction.js";
import type { ToolRiskLevel } from "../shared/types.js";
import type { ApprovalRecord, RunSnapshot } from "./types.js";

export type ApprovalCheckResult =
  | { decision: "allow"; reason: string; consumedApproval?: ApprovalRecord }
  | { decision: "require_approval"; record: ApprovalRecord }
  | { decision: "block"; reason: string };

const DEFAULT_APPROVAL_TTL_MS = 15 * 60_000;

/**
 * Human-in-the-Loop（人机协同）审批状态机：
 * - read / network_read：自动放行
 * - write / network_write：生产环境直接阻断；sandbox/staging 必须经人工审批
 * - 审批通过后生成与 actionDigest = sha256(toolName + args) 强绑定的单次授权，
 *   恢复执行时只能消费一次，彻底防止“审批后偷偷改参数”或重复重放。
 */
export class ApprovalGate {
  constructor(
    private readonly ttlMs = DEFAULT_APPROVAL_TTL_MS,
    private readonly now: () => number = () => Date.now()
  ) {}

  computeActionDigest(toolName: string, args: unknown): string {
    return sha256Digest({ toolName, args });
  }

  evaluateBeforeCall(
    snapshot: RunSnapshot,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    risk: ToolRiskLevel
  ): ApprovalCheckResult {
    // 只读类工具直接放行
    if (risk === "read" || risk === "network_read") {
      return { decision: "allow", reason: "READ_ONLY_AUTO_ALLOW" };
    }

    // 生产环境禁止 Agent 执行任何写操作
    if (snapshot.task.environment === "production") {
      return {
        decision: "block",
        reason: `PRODUCTION_WRITE_FORBIDDEN: tool "${toolName}" (${risk}) is blocked in production`
      };
    }

    const actionDigest = this.computeActionDigest(toolName, args);
    const nowMs = this.now();

    // 过期清理
    for (const record of snapshot.approvals) {
      if (
        (record.status === "pending" || record.status === "approved") &&
        Date.parse(record.expiresAt) <= nowMs
      ) {
        record.status = "expired";
      }
    }

    // 检查是否存在已批准且完全匹配当前参数摘要的一次性授权
    const granted = snapshot.approvals.find(
      (record) =>
        record.status === "approved" &&
        record.toolName === toolName &&
        record.actionDigest === actionDigest
    );

    if (granted) {
      granted.status = "consumed";
      return {
        decision: "allow",
        reason: `APPROVAL_GRANT_CONSUMED:${granted.approvalId}`,
        consumedApproval: granted
      };
    }

    // 否则创建新的挂起审批记录，暂停执行等待前端/CLI 人工决定
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + this.ttlMs).toISOString();
    const record: ApprovalRecord = {
      approvalId: `apr_${randomUUID().slice(0, 10)}`,
      runId: snapshot.runId,
      toolCallId,
      toolName,
      args: redactValue(args) as Record<string, unknown>,
      actionDigest,
      risk,
      reason: `Tool "${toolName}" performs a ${risk} operation and requires explicit human approval.`,
      status: "pending",
      createdAt,
      expiresAt
    };

    snapshot.approvals.push(record);
    return { decision: "require_approval", record };
  }

  decide(
    snapshot: RunSnapshot,
    approvalId: string,
    decision: "approved" | "denied",
    decidedBy: string,
    note?: string
  ): ApprovalRecord {
    const record = snapshot.approvals.find((item) => item.approvalId === approvalId);
    if (!record) {
      throw new Error(`Approval "${approvalId}" not found in run "${snapshot.runId}"`);
    }
    if (record.status !== "pending") {
      throw new Error(`Approval "${approvalId}" is already in terminal state "${record.status}"`);
    }
    if (Date.parse(record.expiresAt) <= this.now()) {
      record.status = "expired";
      throw new Error(`Approval "${approvalId}" has expired`);
    }

    const nowIso = new Date(this.now()).toISOString();
    record.status = decision;
    record.decidedBy = decidedBy;
    record.decidedAt = nowIso;
    if (note) record.decisionNote = note;

    const waitMs = Math.max(0, Date.parse(nowIso) - Date.parse(record.createdAt));
    snapshot.metrics.approvalWaitMs += waitMs;

    return record;
  }
}
