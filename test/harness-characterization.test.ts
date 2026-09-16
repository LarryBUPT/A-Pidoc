import assert from "node:assert/strict";
import test from "node:test";
import { createFixtureApp } from "../src/app.js";
import { getCase } from "../src/fixtures/cases.js";
import { evaluateRepositories } from "../src/evaluation/repository-eval.js";
import { evaluateContracts } from "../src/evaluation/contract-eval.js";
import { evaluateCollaboration } from "../src/evaluation/collaboration-eval.js";
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
test("V2-V4 frozen outputs survive Harness contract extraction", async () => {
  assert.deepEqual(await evaluateRepositories(), { passed: true, repositories: 3, calls: 8, unresolvedCalls: 2, clients: ["axios", "fetch", "okhttp", "requests"], repair: { beforeErrors: 1, afterErrors: 0, testsPassed: true } });
  assert.deepEqual(await evaluateContracts(), { passed: true, diff: { total: 7, breaking: 5 }, impact: { calls: 2, impactedCalls: 2, impacts: 5 }, migration: { beforeImpacts: 1, afterImpacts: 0, testsPassed: true } });
  assert.deepEqual(await evaluateCollaboration(), { passed: true, platforms: 5, publications: 1, storedCases: 1, retrievedCases: 1, postmanRequests: 1, regressionTestGenerated: true, logsRedacted: true, traceComplete: true });
});
