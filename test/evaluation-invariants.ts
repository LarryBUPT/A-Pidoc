import assert from "node:assert/strict";
import type { evaluateRepositories } from "../src/evaluation/repository-eval.js";
import type { evaluateContracts } from "../src/evaluation/contract-eval.js";
import type { evaluateCollaboration } from "../src/evaluation/collaboration-eval.js";

// Test-owned semantic contracts, independent of the evaluators' frozen-count predicates.
export function assertRepositoryEvaluation(result: Awaited<ReturnType<typeof evaluateRepositories>>): void {
  assert.equal(result.passed, true);
  assert.ok(result.repositories > 0);
  assert.ok(result.calls > result.unresolvedCalls);
  assert.ok(result.unresolvedCalls > 0, "unsupported calls must remain visible");
  assert.deepEqual(result.clients, ["axios", "fetch", "okhttp", "requests"]);
  assert.ok(result.repair.beforeErrors > result.repair.afterErrors);
  assert.equal(result.repair.afterErrors, 0);
  assert.equal(result.repair.testsPassed, true);
}

export function assertContractEvaluation(result: Awaited<ReturnType<typeof evaluateContracts>>): void {
  assert.equal(result.passed, true);
  assert.ok(result.diff.total >= result.diff.breaking && result.diff.breaking > 0);
  assert.ok(result.impact.calls >= result.impact.impactedCalls && result.impact.impactedCalls > 0);
  assert.ok(result.impact.impacts >= result.impact.impactedCalls);
  assert.ok(result.migration.beforeImpacts > result.migration.afterImpacts);
  assert.equal(result.migration.afterImpacts, 0);
  assert.equal(result.migration.testsPassed, true);
}

export function assertCollaborationEvaluation(result: Awaited<ReturnType<typeof evaluateCollaboration>>): void {
  assert.equal(result.passed, true);
  assert.ok(result.platforms > 0 && result.publications > 0);
  assert.ok(result.storedCases >= result.retrievedCases && result.retrievedCases > 0);
  assert.ok(result.postmanRequests > 0);
  assert.equal(result.regressionTestGenerated, true);
  assert.equal(result.logsRedacted, true);
  assert.equal(result.traceComplete, true);
}
