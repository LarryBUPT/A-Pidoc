import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { harness, task, tool } from "./harness-helpers.js";
import { PiLoopAdapter, type LoopHooks } from "../src/harness/pi-loop-adapter.js";
import { ConvergentWorkspace, resolveEvidence } from "../src/api-harness/convergent-workspace.js";
import { ContextProjector } from "../src/api-harness/context-projector.js";
import { EvidenceGate } from "../src/api-harness/evidence-gate.js";
import { ApiGuardrail } from "../src/api-harness/api-guardrail.js";
import type { EvidencePackage } from "../src/api-harness/contracts.js";
import { digest } from "../src/harness/digest.js";
import { appendStep } from "../src/harness/trajectory-store.js";
import type { HarnessTool } from "../src/harness/contracts.js";

function evidenceTool(name: string, kind: string, data: unknown, write = false): HarnessTool {
  return { ...tool(name, async (_input, context) => ({ success: true, data, evidence: [{ id: `${kind}-${context.toolCallId}`, kind, sha256: digest(data), mediaType: "application/json", toolCallId: context.toolCallId }], warnings: [], durationMs: 0, redacted: true, ...(write ? { controlPlaneChanged: true } : {}) })), evidenceKinds: [kind], risk: write ? "write" : "read", idempotency: "keyed" };
}
async function runtime(t: TestContext, failedAfter = false, wrongOperation = false) {
  const data = (status: number) => ({ request: { method: "POST", url: "https://fixture.local/orders" }, response: { status, body: { result: status === 200 ? "ok" : "bad media type" } }, sideEffect: false });
  const tools = [evidenceTool("before", "http_observation", data(415)), evidenceTool("spec", "api_operation", { path: wrongOperation ? "/other" : "/orders", method: "POST", contractDigest: "v1" }), evidenceTool("after", "http_observation", data(failedAfter ? 500 : 200))];
  const h = await harness(t, tools, [fauxAssistantMessage(fauxToolCall("before", {}, { id: "before" })), fauxAssistantMessage(fauxToolCall("spec", {}, { id: "spec" })), fauxAssistantMessage(fauxToolCall("after", {}, { id: "after" })), fauxAssistantMessage("done")]);
  const workspace = new ConvergentWorkspace(h.store, h.registry), projector = new ContextProjector(h.store), gate = new EvidenceGate(h.store);
  const adapter = new PiLoopAdapter(h.store, h.registry, { ...h.options, hooks: { afterTool: (c, r, e) => workspace.record(c, r, e), project: m => projector.project(m) } });
  const input = task(); input.taskFamily = "runtime-api"; await adapter.start(input);
  const p: EvidencePackage = { claimRefs: [{ claim: "The corrected request returned 200", evidenceIds: ["http_observation-after"] }], httpObservationIds: ["http_observation-before", "http_observation-after"] };
  return { ...h, workspace, projector, gate, p };
}
test("workspace facts have actual tool IDs, source/hash integrity and persisted recovery", async t => {
  const h = await runtime(t); const s = await h.store.load();
  assert.ok(s.evidenceSequence > 3); assert.equal(s.workspaceRevision, 0); assert.equal(s.run.evidence.length, 3);
  for (const r of s.run.evidence) assert.ok(resolveEvidence(s, r.id));
  assert.deepEqual(await new ConvergentWorkspace(h.store, h.registry).view(), await h.workspace.view());
  assert.notEqual((await h.workspace.view()).stage, "verification_passed");
});
test("runtime completion needs reproduction, matching operation and later successful observation", async t => {
  const h = await runtime(t); assert.equal((await h.gate.complete(h.p)).status, "resolved");
  assert.equal((await h.workspace.view()).stage, "verification_passed"); assert.equal((await h.store.load()).run.state, "resolved");
  assert.ok((await h.store.load()).run.finalArtifact); assert.equal((await h.gate.complete(h.p)).status, "resolved");
  const failed = await runtime(t, true); assert.equal((await failed.gate.evaluate(failed.p)).status, "unresolved");
  const wrong = await runtime(t, false, true); assert.equal((await wrong.gate.evaluate(wrong.p)).status, "unresolved");
});
test("missing evidence, forged claims and Artifact changes reject successful proposal", async t => {
  const h = await runtime(t);
  assert.equal((await h.gate.evaluate({ ...h.p, httpObservationIds: ["http_observation-after"] })).status, "unresolved");
  assert.equal((await h.gate.evaluate({ ...h.p, claimRefs: [{ claim: "done", evidenceIds: ["invented-id"] }] })).status, "unresolved");
  await h.store.transact(s => { (s.artifacts["http_observation-after"] as { data: unknown }).data = { response: { status: 200 }, forged: true }; });
  assert.equal((await h.gate.evaluate(h.p)).status, "unresolved");
});
test("approval waiting, pending-reissue and in-doubt states can never be resolved", async t => {
  const h = await runtime(t);
  for (const state of ["waiting_approval", "approval_granted_pending_reissue", "blocked"] as const) {
    await h.store.transact(s => { s.run.state = state; }); assert.equal((await h.gate.evaluate(h.p)).status, "blocked");
  }
  await h.store.transact(s => { s.run.state = "running"; s.executionInDoubt = { toolCallId: "in-doubt", actionDigest: "digest" }; });
  assert.equal((await h.gate.evaluate(h.p)).status, "blocked");
});
test("context projection stays bounded with protocol-complete tool results and preserves facts", async t => {
  const h = await runtime(t); const s = await h.store.load(), old = JSON.stringify(s);
  const huge = [...s.messages, { role: "assistant", content: [{ type: "toolCall", name: "before", id: "large", arguments: {} }], timestamp: Date.now() }, { role: "toolResult", toolCallId: "large", toolName: "before", content: [{ type: "text", text: "x".repeat(100_000) }], isError: false, timestamp: Date.now() }];
  const projected = await h.projector.project(huge);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) < 32_768); assert.ok(JSON.stringify(projected).includes("http_observation-after")); assert.ok(JSON.stringify(projected).includes("large"));
  assert.equal(JSON.stringify(await h.store.load()), old);
});
test("hypotheses stay bounded and cannot become facts or skip evidence maturity", async t => {
  const h = await runtime(t);
  await h.workspace.hypothesize({ id: "media", claim: "Maybe content type", evidenceIds: ["http_observation-before"], missing: ["successful retest"] });
  assert.equal((await h.workspace.view()).confirmedFacts.length, 3); assert.equal((await h.workspace.view()).openHypotheses.length, 1);
  await assert.rejects(h.workspace.hypothesize({ id: "fake", claim: "done", evidenceIds: ["fabricated"], missing: [] }), /HYPOTHESIS/);
});
test("repeated observations count sequence but reach no-progress hard stop", async t => {
  const observe = evidenceTool("observe", "http_observation", { status: 415 });
  const responses = Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(fauxToolCall("observe", {}, { id: `repeat-${i}` })));
  const h = await harness(t, [observe], responses); const workspace = new ConvergentWorkspace(h.store, h.registry);
  const adapter = new PiLoopAdapter(h.store, h.registry, { ...h.options, hooks: { afterTool: (c, r, e) => workspace.record(c, r, e) } });
  const s = await adapter.start(task()); assert.equal(s.run.state, "blocked"); assert.equal(s.run.evidence.length, 4); assert.ok(s.evidenceSequence >= 4); assert.equal(h.provider.state.callCount, 4); assert.equal((await workspace.view()).noProgressCount, 3);
});
test("ordinary observations do not invalidate approvals; explicit control changes do", async t => {
  const h = await runtime(t); const s = await h.store.load(); await h.workspace.controlChanged();
  const changed = await h.store.load(); assert.equal(changed.workspaceRevision, s.workspaceRevision + 1); assert.ok(changed.evidenceSequence > s.evidenceSequence); assert.ok(changed.stateRevision > s.stateRevision);
  assert.equal((await h.gate.evaluate(h.p)).status, "unresolved");
});
async function migration(t: TestContext, exitCode = 0) {
  const tools = [evidenceTool("diff", "contract_diff", { changes: ["amount type"] }), evidenceTool("impact", "contract_impact", { contractDiffId: "contract_diff-diff", impacts: ["client.ts:1"] }), evidenceTool("patch", "isolated_patch", { contractDiffId: "contract_diff-diff", applied: true, isolated: true }, true), evidenceTool("test", "test_run", { patchArtifactId: "isolated_patch-patch", exitCode, commandDigest: digest(["node", "registered-test"]), testCount: 1, passed: exitCode === 0 }, true)];
  const h = await harness(t, tools, [fauxAssistantMessage(fauxToolCall("diff", {}, { id: "diff" })), fauxAssistantMessage(fauxToolCall("impact", {}, { id: "impact" })), fauxAssistantMessage(fauxToolCall("patch", {}, { id: "blocked-patch" })), fauxAssistantMessage(fauxToolCall("patch", {}, { id: "patch" })), fauxAssistantMessage(fauxToolCall("test", {}, { id: "blocked-test" })), fauxAssistantMessage(fauxToolCall("test", {}, { id: "test" })), fauxAssistantMessage("done")]);
  const workspace = new ConvergentWorkspace(h.store, h.registry), projector = new ContextProjector(h.store);
  const guard = new ApiGuardrail(h.store, h.registry, { policy: { hosts: [], ports: [], environments: ["sandbox"], credentialScopes: [] }, policyVersion: "p1", describe: async c => ({ environment: "sandbox", workspace: "isolated", sideEffectFree: !["patch", "test"].includes(c.name), conditionalExecution: true, preconditions: { fixture: "frozen" } }), authorizeApproval: i => i.actorId === "reviewer", withActionLock: async (_c, action) => action() });
  const g = guard.hooks(), hooks: LoopHooks = { ...g, afterTool: async (c, r, e) => { await g.afterTool?.(c, r, e); await workspace.record(c, r, e); }, project: m => projector.project(m) };
  const adapter = new PiLoopAdapter(h.store, h.registry, { ...h.options, hooks }); const input = task(); input.taskFamily = "repository-contract";
  let s = await adapter.start(input);
  for (let i = 0; i < 2; i++) { await guard.grant(s.pendingApproval!.approvalId, { actorId: "reviewer", source: "test" }); s = await guard.resume(adapter); }
  let current = true;
  const gate = new EvidenceGate(h.store, async () => current);
  const p: EvidencePackage = { contractDiffId: "contract_diff-diff", patchArtifactId: "isolated_patch-patch", testRunId: "test_run-test", testExitCode: 0, httpObservationIds: [], claimRefs: [{ claim: "Isolated test passed", evidenceIds: ["test_run-test"] }] };
  return { ...h, gate, p, workspace, changeCurrent: () => { current = false; } };
}
test("migration requires linked diff, impact, isolated patch, approved execution and actual exit 0", async t => {
  const h = await migration(t); assert.equal((await h.gate.complete(h.p)).status, "resolved"); assert.equal((await h.store.load()).workspaceRevision, 2);
  const failed = await migration(t, 1); assert.equal((await failed.gate.evaluate(failed.p)).status, "unresolved"); assert.notEqual((await failed.workspace.view()).stage, "verification_passed");
});
test("model exit 0 cannot override missing, mismatched or stale actual verification", async t => {
  const h = await migration(t);
  assert.equal((await h.gate.evaluate({ ...h.p, testRunId: "fabricated" })).status, "unresolved");
  assert.equal((await h.gate.evaluate({ ...h.p, contractDiffId: "other" })).status, "unresolved");
  h.changeCurrent(); assert.equal((await h.gate.evaluate(h.p)).status, "unresolved");
  assert.equal((await new EvidenceGate(h.store).evaluate(h.p)).status, "unresolved");
});
test("Reviewer-like pass or model claims cannot replace absent approval evidence", async t => {
  const h = await migration(t); await h.store.transact(s => { s.run.steps.forEach(v => { if (v.kind === "approval") v.data = { type: "untrusted-pass" }; }); appendStep(s, "review", { decision: "pass" }); });
  assert.equal((await h.gate.evaluate(h.p)).status, "unresolved");
});
test("transform failure safely falls back without losing executed facts", async t => {
  const observed = evidenceTool("observe", "api_operation", { method: "GET", path: "/orders", contractDigest: "v1" });
  const h = await harness(t, [observed], [fauxAssistantMessage(fauxToolCall("observe", {}, { id: "fallback" })), context => { assert.ok(JSON.stringify(context.messages).includes("api_operation-fallback")); return fauxAssistantMessage("done"); }]);
  const workspace = new ConvergentWorkspace(h.store, h.registry);
  const adapter = new PiLoopAdapter(h.store, h.registry, { ...h.options, hooks: { afterTool: (c, r, e) => workspace.record(c, r, e), project: async () => { throw new Error("projection unavailable"); } } });
  const s = await adapter.start(task()); assert.equal(s.run.evidence.length, 1); assert.equal(h.provider.state.callCount, 2); assert.notEqual(s.run.state, "failed");
});
test("post-completion non-evidence tools cannot undo verification stage", async t => {
  const h = await runtime(t); await h.gate.complete(h.p);
  await h.workspace.record({ id: "finish", name: "spec", args: {} }, { success: true, data: {}, evidence: [], warnings: [], durationMs: 0, redacted: true }, false);
  assert.equal((await h.workspace.view()).stage, "verification_passed"); assert.equal((await h.store.load()).run.state, "resolved");
});
