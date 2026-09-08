import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { diffOpenApi } from "../contract/openapi-diff.js";
import { analyzeContractImpact } from "../contract/impact-analysis.js";
import { verifyContractMigration } from "../contract/migration.js";

async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }

export async function evaluateContracts(): Promise<{
  passed: boolean;
  diff: { total: number; breaking: number };
  impact: { calls: number; impactedCalls: number; impacts: number };
  migration: { beforeImpacts: number; afterImpacts: number; testsPassed: boolean };
}> {
  const impactRoot = resolve("test/fixtures/repository-v3-impact"); const previous = await json(resolve(impactRoot, "old.json")); const next = await json(resolve(impactRoot, "new.json")); const diff = diffOpenApi(previous, next); const impact = await analyzeContractImpact({ root: impactRoot, previousDocument: previous, nextDocument: next });
  const migrationRoot = resolve("test/fixtures/repository-v3-migration"); const migrationPrevious = await json(resolve(migrationRoot, "old.json")); const migrationNext = await json(resolve(migrationRoot, "new.json")); const parent = await mkdtemp(join(tmpdir(), "a-pidoc-contract-eval-"));
  try {
    const migration = await verifyContractMigration({ root: migrationRoot, workspace: resolve(parent, "workspace"), previousDocument: migrationPrevious, nextDocument: migrationNext, approved: true });
    const result = { diff: { total: diff.summary.total, breaking: diff.summary.breaking }, impact: { calls: impact.summary.calls, impactedCalls: impact.summary.impactedCalls, impacts: impact.impacts.length }, migration: { beforeImpacts: migration.before.impacts.length, afterImpacts: migration.after.impacts.length, testsPassed: migration.testRun.passed } };
    return { passed: result.diff.total === 7 && result.diff.breaking === 5 && result.impact.calls === 2 && result.impact.impactedCalls === 2 && result.impact.impacts === 5 && result.migration.beforeImpacts === 1 && result.migration.afterImpacts === 0 && result.migration.testsPassed, ...result };
  } finally { await rm(parent, { recursive: true, force: true }); }
}
