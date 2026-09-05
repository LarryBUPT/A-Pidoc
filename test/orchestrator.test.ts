import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicReasoner } from "../src/agent/deterministic-reasoner.js";
import { createFixtureApp } from "../src/app.js";
import { DebugOrchestrator } from "../src/core/orchestrator.js";
import { cases, getCase } from "../src/fixtures/cases.js";
import { FixtureHttpTool } from "../src/tools/fixture-http-tool.js";

test("all controlled cases complete the diagnosis and verification loop", async () => {
  for (const item of cases) {
    const report = await createFixtureApp(item).run(item, { expectedRootCause: item.expectedRootCause });
    assert.equal(report.status, "resolved", item.id);
    assert.equal(report.rootCause, item.expectedRootCause, item.id);
    assert.equal(report.evaluation.passed, true, item.id);
    assert.ok(report.trace.some((event) => event.stage === "http_tool"), item.id);
    assert.ok(report.trace.some((event) => event.stage === "evidence_review"), item.id);
  }
});

test("a bad host is blocked before the HTTP tool runs", async () => {
  const item = getCase("auth-header");
  item.request.url = "https://example.com/orders";
  const report = await new DebugOrchestrator(new FixtureHttpTool(item), new DeterministicReasoner()).run(item);
  assert.equal(report.status, "blocked");
  assert.equal(report.attempts.length, 0);
  assert.match(report.summary, /Blocked host/);
});

test("the trace uses monotonic sequence numbers", async () => {
  const item = getCase("body-type");
  const report = await createFixtureApp(item).run(item, { expectedRootCause: item.expectedRootCause });
  assert.deepEqual(
    report.trace.map((event) => event.seq),
    report.trace.map((_, index) => index + 1)
  );
});
