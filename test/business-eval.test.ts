import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBusinessCases } from "../src/evaluation/business-eval.js";
import { DeterministicReasoner } from "../src/agent/deterministic-reasoner.js";
import { EvidenceReviewer } from "../src/agent/reviewer.js";
import { DebugOrchestrator } from "../src/core/orchestrator.js";
import type { Reasoner } from "../src/domain/types.js";
import { getCase } from "../src/fixtures/cases.js";
import { FixtureHttpTool } from "../src/tools/fixture-http-tool.js";

test("frozen business evaluation runs at least twenty real local HTTP cases and ten fault categories", async () => {
  const result = await evaluateBusinessCases();
  assert.ok(result.total >= 20);
  assert.ok(result.faultCategories >= 10);
  assert.equal(result.passed, result.total, JSON.stringify(result.results.filter((r) => !r.passed)));
  assert.equal(result.unsafeMutations, 0);
  assert.equal(result.modelCalls, 0);
});

test("a repair with the right field type but invented value is blocked before retry", async () => {
  const item = getCase("body-type");
  let calls = 0;
  const tool = new FixtureHttpTool(item);
  const reasoner: Reasoner = { runtime: { mode: "deterministic", fallback: "none" }, diagnose: async (input) => ({
    ...await new DeterministicReasoner().diagnose(input), action: { kind: "set_body", name: "amount", value: 999999 }
  }) };
  const report = await new DebugOrchestrator({ execute: async (request) => { calls++; return tool.execute(request); } }, reasoner).run(item);
  assert.equal(report.status, "blocked");
  assert.equal(calls, 1);
  assert.match(report.summary, /UNSUPPORTED_REPAIR/);
});

test("Reviewer rejects repeated unsupported evidence and unexpected request changes", async () => {
  const item = getCase("body-type");
  const report = await new DebugOrchestrator(new FixtureHttpTool(item), new DeterministicReasoner()).run(item);
  assert.equal(report.evaluation.passed, true);
  const reviewer = new EvidenceReviewer();
  const wrong = structuredClone(report.attempts);
  wrong[1]!.request.url = "https://fixture.local/other";
  assert.equal(reviewer.review(wrong, report.rootCause).evidenceComplete, false);
  const repeated = structuredClone(report.attempts);
  repeated[0]!.diagnosis!.evidence = [{ source: "knowledge_rule", detail: "guess" }, { source: "knowledge_rule", detail: "guess" }];
  assert.equal(reviewer.review(repeated, report.rootCause).evidenceComplete, false);
});
