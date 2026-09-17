import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixtureApp } from "../src/app.js";
import { buildPlatformReply, normalizeCollaborationPayload } from "../src/collaboration/adapters.js";
import { FixtureCollaborationConnector, FixtureLogConnector } from "../src/collaboration/connectors.js";
import { JsonKnowledgeStore } from "../src/collaboration/knowledge-store.js";
import { CollaborationPolicy } from "../src/collaboration/policy.js";
import { exportPostmanCollection, importPostmanCollection } from "../src/collaboration/postman.js";
import type { CollaborationPlatform, CollaborationSummary, KnowledgeCase } from "../src/collaboration/types.js";
import { CollaborationWorkflow } from "../src/collaboration/workflow.js";
import { evaluateCollaboration } from "../src/evaluation/collaboration-eval.js";
import { assertCollaborationEvaluation } from "./evaluation-invariants.js";
import { getCase } from "../src/fixtures/cases.js";

const execute = promisify(execFile);

function platformPayloads(): Record<CollaborationPlatform, unknown> {
  return {
    github: { repository: { full_name: "team/service" }, pull_request: { number: 7, title: "Upgrade", body: "token=secret-value-123" }, correlation_id: "c-1" },
    gitlab: { project: { path_with_namespace: "team/service" }, object_attributes: { iid: 8, title: "Upgrade", description: "diagnose" }, correlation_id: "c-1" },
    jira: { issue: { key: "API-1", fields: { summary: "Failure", description: "diagnose", correlationId: "c-1" } } },
    slack: { team_id: "T1", event: { channel: "C1", ts: "1.2", text: "diagnose", thread_ts: "c-1" } },
    feishu: { event: { message: { chat_id: "chat-1", message_id: "m-1", content: "{\"text\":\"diagnose\"}" } }, correlation_id: "c-1" }
  };
}

const summary: CollaborationSummary = { workItemId: "item", status: "resolved", rootCause: "CONTENT_TYPE_MISMATCH", attempts: 2, evidenceComplete: true, relatedCases: 1, logEvents: 1, regressionTest: "Postman status assertion generated for 200", message: "verified" };

test("V4 normalizes five collaboration payloads and builds platform replies", () => {
  const items = (Object.entries(platformPayloads()) as Array<[CollaborationPlatform, unknown]>).map(([platform, payload]) => normalizeCollaborationPayload(platform, payload, "tenant-a"));
  assert.deepEqual(items.map((item) => item.platform).sort(), ["feishu", "github", "gitlab", "jira", "slack"]);
  assert.match(items[0]!.description, /\[REDACTED\]/);
  for (const item of items) { const reply = buildPlatformReply(item, { ...summary, workItemId: item.id }); assert.equal(reply.platform, item.platform); assert.equal(reply.method, "POST"); assert.ok(reply.path.startsWith("/")); }
});

test("V4 rejects malformed collaboration payloads and enforces role, tenant, and log limits", async () => {
  assert.throws(() => normalizeCollaborationPayload("github", { repository: {} }, "tenant-a"), /pull_request must be an object/);
  const policy = new CollaborationPolicy(); const item = normalizeCollaborationPayload("jira", platformPayloads().jira, "tenant-a");
  assert.throws(() => policy.assertTenant({ id: "other", tenantId: "tenant-b", role: "admin" }, item), /another tenant/);
  assert.throws(() => policy.assertPermission({ id: "viewer", tenantId: "tenant-a", role: "viewer" }, "read_logs"), /cannot read_logs/);
  assert.throws(() => policy.assertApproved(false, "publish"), /Explicit approval/);
  await assert.rejects(new FixtureLogConnector([]).query({ tenantId: "tenant-a", correlationId: "c-1", limit: 51 }), /between 1 and 50/);
});

test("V4 imports and exports bounded Postman collections with redaction", () => {
  const imported = importPostmanCollection({ item: [
    { name: "valid", request: { method: "POST", url: "https://api.example.test/orders", header: [{ key: "Authorization", value: "Bearer secret-value-123" }], body: { mode: "raw", raw: "{\"amount\":42}" } } },
    { name: "form", request: { method: "POST", url: "https://api.example.test/orders", body: { mode: "formdata" } } }
  ] });
  assert.equal(imported.requests.length, 1); assert.equal(imported.unsupportedItems.length, 1); assert.equal(imported.requests[0]!.body?.amount, 42);
  const exported = JSON.stringify(exportPostmanCollection(imported.requests)); assert.doesNotMatch(exported, /secret-value-123/); assert.match(exported, /\[REDACTED\]/);
  assert.match(JSON.stringify(exportPostmanCollection(imported.requests, "regression", 200)), /pm\.response\.to\.have\.status\(200\)/);
});

test("V4 persists only structured redacted knowledge and retrieves within one tenant", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "a-pidoc-knowledge-test-")); context.after(() => rm(root, { recursive: true, force: true })); const file = join(root, "cases.json"); const store = new JsonKnowledgeStore(file);
  const record: KnowledgeCase = { id: "case-1", tenantId: "tenant-a", errorSignature: "token=secret-value-123", operation: "POST /orders", rootCause: "CONTENT_TYPE_MISMATCH", effectiveFix: "set Content-Type", verification: "second request returned 200", applicableVersion: "v4", evidenceSources: ["Bearer secret-value-123"], createdAt: "2026-09-16T00:00:00.000Z" };
  await store.save(record); const serialized = await readFile(file, "utf8"); assert.doesNotMatch(serialized, /secret-value-123/); assert.match(serialized, /\[REDACTED\]/);
  assert.equal((await store.findSimilar({ tenantId: "tenant-a", operation: "POST /orders" })).length, 1); assert.equal((await store.findSimilar({ tenantId: "tenant-b", operation: "POST /orders" })).length, 0);
});

test("V4 runs diagnosis without side effects when approvals are absent", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "a-pidoc-v4-no-approval-")); context.after(() => rm(root, { recursive: true, force: true })); const caseData = getCase("content-type"); const item = { ...normalizeCollaborationPayload("jira", platformPayloads().jira, "tenant-a"), debugTask: caseData }; const connector = new FixtureCollaborationConnector(item); const store = new JsonKnowledgeStore(join(root, "cases.json"));
  const report = await new CollaborationWorkflow(connector, new FixtureLogConnector([]), store, createFixtureApp(caseData)).run({ actor: { id: "operator", tenantId: "tenant-a", role: "operator" }, reference: item.id, approvals: { publish: false, saveKnowledge: false }, expectation: { expectedRootCause: caseData.expectedRootCause } });
  assert.equal(report.passed, true); assert.equal(report.publication, null); assert.equal(report.savedCase, null); assert.equal(connector.publications.length, 0); await assert.rejects(readFile(join(root, "cases.json"), "utf8"), /ENOENT/);
});

test("V4 completes Jira to logs, diagnosis, publication and knowledge workflow", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "a-pidoc-v4-workflow-")); context.after(() => rm(root, { recursive: true, force: true })); const caseData = getCase("content-type"); const item = { ...normalizeCollaborationPayload("jira", platformPayloads().jira, "tenant-a"), debugTask: caseData }; const connector = new FixtureCollaborationConnector(item); const store = new JsonKnowledgeStore(join(root, "cases.json")); const logs = new FixtureLogConnector([{ id: "l-1", tenantId: "tenant-a", correlationId: "c-1", at: "2026-09-16T00:00:00.000Z", level: "error", message: "Bearer secret-value-123", attributes: { token: "secret-value-123" } }]);
  const report = await new CollaborationWorkflow(connector, logs, store, createFixtureApp(caseData)).run({ actor: { id: "reviewer", tenantId: "tenant-a", role: "reviewer" }, reference: item.id, approvals: { publish: true, saveKnowledge: true }, expectation: { expectedRootCause: caseData.expectedRootCause } });
  assert.equal(report.passed, true); assert.equal(report.publication?.platform, "jira"); assert.equal(report.savedCase?.operation, "POST /orders"); assert.match(JSON.stringify(report.regressionCollection), /pm\.response\.to\.have\.status\(200\)/); assert.doesNotMatch(JSON.stringify(report), /secret-value-123/); assert.equal((await store.findSimilar({ tenantId: "tenant-a", operation: "POST /orders" })).length, 1);
  assert.deepEqual(report.trace.filter((event) => event.status === "succeeded").map((event) => event.stage), ["read_collaboration_item", "retrieve_structured_knowledge", "query_linked_logs", "run_evidence_diagnosis", "publish_collaboration_report", "save_structured_knowledge"]);
});

test("V4 collaboration evaluation preserves knowledge, redaction and evidence invariants", async () => {
  assertCollaborationEvaluation(await evaluateCollaboration());
});

test("collaboration-demo CLI runs the frozen V4 workflow", async () => {
  const { stdout } = await execute(process.execPath, ["dist/src/cli.js", "collaboration-demo"], { cwd: process.cwd() }); const output = JSON.parse(stdout) as { passed: boolean; platforms: number };
  assert.equal(output.passed, true); assert.equal(output.platforms, 5);
});
