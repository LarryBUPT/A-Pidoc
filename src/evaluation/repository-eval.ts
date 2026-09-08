import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { scanRepository } from "../repository/scanner.js";
import { verifyRepositoryPlan } from "../repository/workflow.js";

const fixtures = ["repository", "repository-v2", "repository-v2-repair"] as const;

export async function evaluateRepositories(): Promise<{
  passed: boolean;
  repositories: number;
  calls: number;
  unresolvedCalls: number;
  clients: string[];
  repair: { beforeErrors: number; afterErrors: number; testsPassed: boolean };
}> {
  const reports = [];
  for (const name of fixtures) {
    const root = resolve("test/fixtures", name);
    const document = JSON.parse(await readFile(resolve(root, "openapi.json"), "utf8"));
    reports.push(await scanRepository({ root, openApiDocument: document }));
  }
  const repairRoot = resolve("test/fixtures/repository-v2-repair");
  const repairDocument = JSON.parse(await readFile(resolve(repairRoot, "openapi.json"), "utf8"));
  const parent = await mkdtemp(join(tmpdir(), "a-pidoc-repository-eval-"));
  try {
    const repair = await verifyRepositoryPlan({ root: repairRoot, workspace: resolve(parent, "workspace"), openApiDocument: repairDocument, approved: true });
    const clients = [...new Set(reports.flatMap((report) => report.apiCalls.map((call) => call.client)))].sort();
    const summary = {
      repositories: reports.length,
      calls: reports.reduce((total, report) => total + report.apiCalls.length, 0),
      unresolvedCalls: reports.reduce((total, report) => total + report.unresolvedCalls.length, 0),
      clients,
      repair: { beforeErrors: repair.before.summary.errors, afterErrors: repair.after.summary.errors, testsPassed: repair.testRun.passed }
    };
    return { passed: summary.repositories === 3 && summary.calls === 8 && summary.unresolvedCalls === 2 && clients.length === 4 && repair.passed, ...summary };
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}
