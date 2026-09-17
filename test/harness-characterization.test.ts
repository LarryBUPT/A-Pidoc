import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureApp } from "../src/app.js";
import { getCase } from "../src/fixtures/cases.js";
import { evaluateRepositories } from "../src/evaluation/repository-eval.js";
import { evaluateContracts } from "../src/evaluation/contract-eval.js";
import { evaluateCollaboration } from "../src/evaluation/collaboration-eval.js";
import { assertRepositoryEvaluation, assertContractEvaluation, assertCollaborationEvaluation } from "./evaluation-invariants.js";
test("V4 retains public report shape, single repair and evidence before migration", async () => {
  const item = getCase("content-type");
  const report = await createFixtureApp(item).run(item, { expectedRootCause: item.expectedRootCause });
  assert.deepEqual(Object.keys(report).sort(), ["runId", "taskId", "inputSource", "status", "originalRequest", "finalRequest", "attempts", "rootCause", "summary", "evaluation", "trace"].sort());
  assert.equal(report.status, "resolved");
  assert.deepEqual(report.attempts.map(a => a.result.status), [415, 200]);
  assert.equal(report.rootCause, "CONTENT_TYPE_MISMATCH");
  assert.equal(report.finalRequest.headers["Content-Type"], "application/json");
  assert.equal(report.evaluation.evidenceComplete, true);
});
test("V2-V4 semantic invariants survive Harness contract extraction", async () => {
  assertRepositoryEvaluation(await evaluateRepositories());
  assertContractEvaluation(await evaluateContracts());
  assertCollaborationEvaluation(await evaluateCollaboration());
});
