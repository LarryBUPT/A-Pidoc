import { createHash } from "node:crypto";
import type { DebugReport, EvaluationExpectation } from "../domain/types.js";
import { TraceRecorder } from "../observability/trace.js";
import { PublicError } from "../security/errors.js";
import { redactText } from "../security/redaction.js";
import { CollaborationPolicy } from "./policy.js";
import { exportPostmanCollection } from "./postman.js";
import type { CollaborationActor, CollaborationConnector, CollaborationSummary, CollaborationWorkflowReport, KnowledgeCase, KnowledgeStore, LogConnector } from "./types.js";

export interface DebugRunner {
  run(task: NonNullable<Awaited<ReturnType<CollaborationConnector["read"]>>["debugTask"]>, expectation?: EvaluationExpectation): Promise<DebugReport>;
}

export interface CollaborationRunOptions {
  actor: CollaborationActor;
  reference: string;
  approvals: { publish: boolean; saveKnowledge: boolean };
  expectation?: EvaluationExpectation;
  logLimit?: number;
}

function operation(report: DebugReport): string { const url = new URL(report.originalRequest.url); return `${report.originalRequest.method} ${url.pathname}`; }
function action(report: DebugReport): string { const diagnosis = [...report.attempts].reverse().find((attempt) => attempt.diagnosis)?.diagnosis; return diagnosis ? JSON.stringify(diagnosis.action) : "no repair action"; }
// Stored knowledge records use the stable V4 collaboration protocol, independently of the package release version.
const COLLABORATION_KNOWLEDGE_PROTOCOL_VERSION = "v4";
function knowledgeCase(tenantId: string, workItemId: string, report: DebugReport, evidence: string[]): KnowledgeCase {
  const last = report.attempts.at(-1); const signature = `${report.rootCause}:${last?.result.status ?? 0}`; const op = operation(report); const fix = action(report);
  const id = createHash("sha256").update(`${tenantId}|${signature}|${op}|${fix}`).digest("hex").slice(0, 16);
  return { id, tenantId, errorSignature: signature, operation: op, rootCause: report.rootCause, effectiveFix: fix, verification: `status=${report.status}; attempts=${report.attempts.length}; evidenceComplete=${report.evaluation.evidenceComplete}`, applicableVersion: COLLABORATION_KNOWLEDGE_PROTOCOL_VERSION, evidenceSources: [`work_item:${workItemId}`, `debug_report:${report.runId}`, ...evidence], createdAt: new Date().toISOString() };
}

export class CollaborationWorkflow {
  constructor(
    private readonly connector: CollaborationConnector,
    private readonly logs: LogConnector,
    private readonly knowledge: KnowledgeStore,
    private readonly runner: DebugRunner,
    private readonly policy = new CollaborationPolicy()
  ) {}

  async run(options: CollaborationRunOptions): Promise<CollaborationWorkflowReport> {
    const trace = new TraceRecorder(); this.policy.assertPermission(options.actor, "read_item");
    const item = await trace.span("read_collaboration_item", () => this.connector.read(options.reference), { actor: options.actor.id, tenantId: options.actor.tenantId });
    this.policy.assertTenant(options.actor, item); const task = item.debugTask;
    if (!task) throw new PublicError("COLLABORATION_TASK_MISSING", "Work item does not contain a validated debug task");
    const op = `${task.request.method} ${new URL(task.request.url).pathname}`;
    const relatedCases = await trace.span("retrieve_structured_knowledge", async () => { this.policy.assertPermission(options.actor, "read_item"); return this.knowledge.findSimilar({ tenantId: options.actor.tenantId, operation: op, limit: 5 }); }, { operation: op });
    const logEvents = item.correlationId === null ? [] : await trace.span("query_linked_logs", async () => { this.policy.assertPermission(options.actor, "read_logs"); return this.logs.query({ tenantId: options.actor.tenantId, correlationId: item.correlationId!, limit: options.logLimit ?? 20 }); }, { correlationId: item.correlationId, redacted: true });
    const diagnosis = await trace.span("run_evidence_diagnosis", async () => { this.policy.assertPermission(options.actor, "run_diagnosis"); return this.runner.run(task, options.expectation); }, { relatedCases: relatedCases.length, logEvents: logEvents.length });
    const finalStatus = diagnosis.attempts.at(-1)?.result.status;
    const regressionCollection = exportPostmanCollection([diagnosis.finalRequest], `A-Pidoc regression for ${item.id}`, finalStatus);
    const summary: CollaborationSummary = { workItemId: item.id, status: diagnosis.status, rootCause: diagnosis.rootCause, attempts: diagnosis.attempts.length, evidenceComplete: diagnosis.evaluation.evidenceComplete, relatedCases: relatedCases.length, logEvents: logEvents.length, regressionTest: `Postman status assertion generated${finalStatus === undefined ? "" : ` for ${finalStatus}`}`, message: redactText(diagnosis.summary) };
    let publication = null; if (options.approvals.publish) publication = await trace.span("publish_collaboration_report", async () => { this.policy.assertPermission(options.actor, "publish_report"); this.policy.assertApproved(true, "publish"); return this.connector.publish(item, summary); }, { platform: item.platform });
    let savedCase = null; if (options.approvals.saveKnowledge && diagnosis.status === "resolved") savedCase = await trace.span("save_structured_knowledge", async () => { this.policy.assertPermission(options.actor, "save_knowledge"); this.policy.assertApproved(true, "save knowledge"); const record = knowledgeCase(item.tenantId, item.id, diagnosis, logEvents.map((event) => `log:${event.id}`)); await this.knowledge.save(record); return record; }, { tenantId: item.tenantId });
    const { debugTask: _debugTask, ...safeItem } = item;
    return { workItem: { ...safeItem, description: redactText(safeItem.description) }, relatedCases, logs: logEvents, diagnosis, summary, regressionCollection, publication, savedCase, approvals: structuredClone(options.approvals), trace: trace.snapshot(), passed: diagnosis.evaluation.passed && (!options.approvals.publish || publication !== null) && (!options.approvals.saveKnowledge || savedCase !== null) };
  }
}
