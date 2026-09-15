import type { DebugReport, DebugTask, RootCause, TraceEvent } from "../domain/types.js";

export type CollaborationPlatform = "github" | "gitlab" | "jira" | "slack" | "feishu";
export type CollaborationRole = "viewer" | "operator" | "reviewer" | "admin";
export type CollaborationPermission = "read_item" | "read_logs" | "run_diagnosis" | "publish_report" | "save_knowledge";

export interface CollaborationActor {
  id: string;
  tenantId: string;
  role: CollaborationRole;
}

export interface CollaborationWorkItem {
  id: string;
  tenantId: string;
  platform: CollaborationPlatform;
  kind: "change_request" | "issue" | "message";
  title: string;
  description: string;
  resource: string;
  replyTarget: string;
  correlationId: string | null;
  debugTask?: DebugTask;
}

export interface CollaborationSummary {
  workItemId: string;
  status: DebugReport["status"];
  rootCause: RootCause;
  attempts: number;
  evidenceComplete: boolean;
  relatedCases: number;
  logEvents: number;
  regressionTest: string;
  message: string;
}

export interface PlatformReply {
  platform: CollaborationPlatform;
  method: "POST";
  path: string;
  body: Record<string, unknown>;
}

export interface PublishedReceipt {
  id: string;
  platform: CollaborationPlatform;
  reply: PlatformReply;
}

export interface CollaborationConnector {
  read(reference: string): Promise<CollaborationWorkItem>;
  publish(item: CollaborationWorkItem, summary: CollaborationSummary): Promise<PublishedReceipt>;
}

export interface LogQuery {
  tenantId: string;
  correlationId: string;
  limit: number;
}

export interface LogEvent {
  id: string;
  tenantId: string;
  correlationId: string;
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  attributes: Record<string, unknown>;
}

export interface LogConnector {
  query(input: LogQuery): Promise<LogEvent[]>;
}

export interface KnowledgeCase {
  id: string;
  tenantId: string;
  errorSignature: string;
  operation: string;
  rootCause: RootCause;
  effectiveFix: string;
  verification: string;
  applicableVersion: string;
  evidenceSources: string[];
  createdAt: string;
}

export interface KnowledgeQuery {
  tenantId: string;
  operation: string;
  rootCause?: RootCause;
  limit?: number;
}

export interface KnowledgeStore {
  findSimilar(query: KnowledgeQuery): Promise<KnowledgeCase[]>;
  save(item: KnowledgeCase): Promise<void>;
}

export interface CollaborationWorkflowReport {
  workItem: Omit<CollaborationWorkItem, "debugTask">;
  relatedCases: KnowledgeCase[];
  logs: LogEvent[];
  diagnosis: DebugReport;
  summary: CollaborationSummary;
  regressionCollection: Record<string, unknown>;
  publication: PublishedReceipt | null;
  savedCase: KnowledgeCase | null;
  approvals: { publish: boolean; saveKnowledge: boolean };
  trace: TraceEvent[];
  passed: boolean;
}
