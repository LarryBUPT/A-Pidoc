import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureApp } from "../app.js";
import { buildPlatformReply, normalizeCollaborationPayload } from "../collaboration/adapters.js";
import { FixtureCollaborationConnector, FixtureLogConnector } from "../collaboration/connectors.js";
import { JsonKnowledgeStore } from "../collaboration/knowledge-store.js";
import { exportPostmanCollection, importPostmanCollection } from "../collaboration/postman.js";
import type { CollaborationPlatform } from "../collaboration/types.js";
import { CollaborationWorkflow } from "../collaboration/workflow.js";
import { getCase } from "../fixtures/cases.js";

function payloads(): Record<CollaborationPlatform, unknown> {
  return {
    github: { repository: { full_name: "team/service" }, pull_request: { number: 7, title: "Upgrade API", body: "trace corr-42" }, correlation_id: "corr-42" },
    gitlab: { project: { path_with_namespace: "team/service" }, object_attributes: { iid: 8, title: "Upgrade API", description: "trace corr-42" }, correlation_id: "corr-42" },
    jira: { issue: { key: "API-42", fields: { summary: "Order API fails", description: "Content-Type mismatch", correlationId: "corr-42" } } },
    slack: { team_id: "T1", event: { channel: "C1", ts: "1.2", text: "Order API fails", thread_ts: "corr-42" } },
    feishu: { event: { message: { chat_id: "chat-1", message_id: "msg-1", content: JSON.stringify({ text: "Order API fails" }) } }, correlation_id: "corr-42" }
  };
}

export async function evaluateCollaboration(): Promise<{ passed: boolean; platforms: number; publications: number; storedCases: number; retrievedCases: number; postmanRequests: number; regressionTestGenerated: boolean; logsRedacted: boolean; traceComplete: boolean }> {
  const normalized = (Object.entries(payloads()) as Array<[CollaborationPlatform, unknown]>).map(([platform, payload]) => normalizeCollaborationPayload(platform, payload, "team-a"));
  const caseData = getCase("content-type"); const jira = { ...normalized.find((item) => item.platform === "jira")!, debugTask: caseData }; const connector = new FixtureCollaborationConnector(jira);
  const logs = new FixtureLogConnector([{ id: "log-1", tenantId: "team-a", correlationId: "corr-42", at: "2026-09-16T00:00:00.000Z", level: "error", message: "authorization=Bearer secret-token-123", attributes: { token: "secret-token-123", status: 415 } }]);
  const parent = await mkdtemp(join(tmpdir(), "a-pidoc-v4-eval-")); const storeFile = join(parent, "knowledge", "cases.json"); const knowledge = new JsonKnowledgeStore(storeFile);
  try {
    const report = await new CollaborationWorkflow(connector, logs, knowledge, createFixtureApp(caseData)).run({ actor: { id: "reviewer-1", tenantId: "team-a", role: "reviewer" }, reference: jira.id, approvals: { publish: true, saveKnowledge: true }, expectation: { expectedRootCause: caseData.expectedRootCause } });
    const retrieved = await knowledge.findSimilar({ tenantId: "team-a", operation: "POST /orders" }); const stored = JSON.parse(await readFile(storeFile, "utf8")) as unknown[];
    const imported = importPostmanCollection({ info: { name: "orders" }, item: [{ name: "create", request: { method: "POST", url: { raw: "https://api.example.test/orders" }, header: [{ key: "Authorization", value: "Bearer secret-token-123" }], body: { mode: "raw", raw: "{\"amount\":42}" } } }] }); const exported = exportPostmanCollection(imported.requests); const serialized = JSON.stringify({ report, stored, exported, reply: buildPlatformReply(jira, report.summary) });
    const stages = report.trace.filter((event) => event.status === "succeeded").map((event) => event.stage); const traceComplete = ["read_collaboration_item", "retrieve_structured_knowledge", "query_linked_logs", "run_evidence_diagnosis", "publish_collaboration_report", "save_structured_knowledge"].every((stage) => stages.includes(stage));
    const regressionTestGenerated = JSON.stringify(report.regressionCollection).includes("pm.response.to.have.status(200)");
    const result = { platforms: normalized.length, publications: connector.publications.length, storedCases: stored.length, retrievedCases: retrieved.length, postmanRequests: imported.requests.length, regressionTestGenerated, logsRedacted: !serialized.includes("secret-token-123") && serialized.includes("[REDACTED]"), traceComplete };
    return { passed: result.platforms === 5 && result.publications === 1 && result.storedCases === 1 && result.retrievedCases === 1 && result.postmanRequests === 1 && result.regressionTestGenerated && result.logsRedacted && result.traceComplete && report.passed, ...result };
  } finally { await rm(parent, { recursive: true, force: true }); }
}
