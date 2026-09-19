import assert from "node:assert/strict";
import test from "node:test";
import { artifactGeneratedAt } from "../src/evaluation/artifact.js";

test("evaluation artifact generation time is deterministic when a clock value is supplied", () => {
  assert.equal(artifactGeneratedAt(Date.UTC(2026, 8, 19, 1, 2, 3, 4)), "2026-09-19T01:02:03.004Z");
  assert.throws(() => artifactGeneratedAt(Number.NaN), /INVALID_ARTIFACT_GENERATION_TIME/);
});
