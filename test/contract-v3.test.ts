import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";
import { diffOpenApi } from "../src/contract/openapi-diff.js";
import { analyzeContractImpact, generateMigrationPatchPlans } from "../src/contract/impact-analysis.js";
import { verifyContractMigration } from "../src/contract/migration.js";
import { evaluateContracts } from "../src/evaluation/contract-eval.js";

async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
const impactRoot = resolve("test/fixtures/repository-v3-impact");
const migrationRoot = resolve("test/fixtures/repository-v3-migration");

test("V3 semantic diff reports stable operation, request and response risks", async () => {
  const previous = await json(resolve(impactRoot, "old.json")); const next = await json(resolve(impactRoot, "new.json"));
  const first = diffOpenApi(previous, next); const second = diffOpenApi(previous, next);
  assert.deepEqual(first.summary, { total: 7, breaking: 5, high: 5, medium: 0, low: 2 });
  assert.deepEqual(first.changes.map((change) => change.id), second.changes.map((change) => change.id));
  assert.deepEqual(new Set(first.changes.map((change) => change.kind)), new Set(["OPERATION_ADDED", "OPERATION_REMOVED", "REQUEST_FIELD_ADDED", "REQUEST_FIELD_REMOVED", "REQUEST_FIELD_TYPE_CHANGED", "RESPONSE_FIELD_ADDED", "RESPONSE_FIELD_REMOVED"]));
});

test("V3 maps only incompatible contract changes to real call locations", async () => {
  const report = await analyzeContractImpact({ root: impactRoot, previousDocument: await json(resolve(impactRoot, "old.json")), nextDocument: await json(resolve(impactRoot, "new.json")) });
  assert.deepEqual(report.summary, { calls: 2, impactedCalls: 2, high: 5, medium: 0, low: 0 });
  assert.deepEqual(new Set(report.impacts.map((impact) => impact.call.line)), new Set([2, 6]));
  assert.equal(generateMigrationPatchPlans(report).length, 0, "unknown business values must not be invented");
});

test("V3 applies a lossless literal migration and runs generated contract tests in isolation", async (context) => {
  const previous = await json(resolve(migrationRoot, "old.json")); const next = await json(resolve(migrationRoot, "new.json")); const parent = await mkdtemp(join(tmpdir(), "a-pidoc-v3-")); context.after(() => rm(parent, { recursive: true, force: true }));
  const result = await verifyContractMigration({ root: migrationRoot, workspace: resolve(parent, "workspace"), previousDocument: previous, nextDocument: next, approved: true });
  assert.equal(result.before.impacts.length, 1); assert.equal(result.after.impacts.length, 0); assert.equal(result.appliedPatches.length, 1); assert.equal(result.writtenTests.length, 1); assert.equal(result.testRun.passed, true, result.testRun.stderr); assert.equal(result.passed, true);
  assert.deepEqual(result.trace.filter((event) => event.status === "succeeded").map((event) => event.stage), ["contract_impact_before", "copy_isolated_workspace", "apply_migration_patches", "contract_impact_after", "generate_contract_tests", "run_contract_tests"]);
  assert.match(await readFile(resolve(result.workspaceRoot, "src/client.ts"), "utf8"), /amount: 42/);
  assert.match(await readFile(resolve(migrationRoot, "src/client.ts"), "utf8"), /amount: "42"/);
});

test("V3 migration refuses absent approval and an existing workspace", async (context) => {
  const previous = await json(resolve(migrationRoot, "old.json")); const next = await json(resolve(migrationRoot, "new.json"));
  await assert.rejects(() => verifyContractMigration({ root: migrationRoot, workspace: resolve("ignored"), previousDocument: previous, nextDocument: next, approved: false }), /explicit approval/);
  const existing = await mkdtemp(join(tmpdir(), "a-pidoc-v3-existing-")); context.after(() => rm(existing, { recursive: true, force: true }));
  await assert.rejects(() => verifyContractMigration({ root: migrationRoot, workspace: existing, previousDocument: previous, nextDocument: next, approved: true }), /already exists/);
});

test("V3 contract evaluation freezes diff, impact and migration evidence", async () => {
  assert.deepEqual(await evaluateContracts(), {
    passed: true,
    diff: { total: 7, breaking: 5 },
    impact: { calls: 2, impactedCalls: 2, impacts: 5 },
    migration: { beforeImpacts: 1, afterImpacts: 0, testsPassed: true }
  });
});

test("contract-verify CLI runs the approved isolated migration", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "a-pidoc-v3-cli-")); context.after(() => rm(parent, { recursive: true, force: true }));
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, ["dist/src/cli.js", "contract-verify", "--root", migrationRoot, "--previous", resolve(migrationRoot, "old.json"), "--next", resolve(migrationRoot, "new.json"), "--workspace", resolve(parent, "workspace"), "--approved", "true"]); let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); }); child.stderr.on("data", (chunk) => { stderr += String(chunk); }); child.on("close", (code) => done({ code, stdout, stderr }));
  });
  assert.equal(output.code, 0, output.stderr); assert.equal((JSON.parse(output.stdout) as { passed: boolean }).passed, true);
});
