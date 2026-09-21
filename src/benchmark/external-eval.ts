import type { DebugReport, ModelUsage, Reasoner } from "../domain/types.js";
import { createRealAppWithReasoner } from "../app.js";
import { DeterministicReasoner } from "../agent/deterministic-reasoner.js";
import {
  assertCaseOraclePair,
  loadExternalBenchmarkCases,
  loadExternalBenchmarkOracle,
  loadRunnerReceipt,
  resolveContainedFile,
  type ExternalBenchmarkCase,
  type ExternalBenchmarkOracleEntry,
  type RunnerReceipt
} from "./contracts.js";

export interface ExternalBenchmarkArm {
  id: string;
  reasoner: Reasoner;
}

export interface ExternalBenchmarkOptions {
  casesPath: string;
  oraclePath: string;
  allowedHosts: readonly string[];
  allowedPorts: readonly number[];
  arms?: readonly ExternalBenchmarkArm[];
}

export interface ExternalBenchmarkScore {
  passed: boolean;
  rootCauseMatched: boolean;
  statusMatched: boolean;
  attemptsMatched: boolean;
  evidenceMatched: boolean;
}

interface ExternalBenchmarkResultBase {
  caseId: string;
  armId: string;
  runtime: Reasoner["runtime"];
  durationMs: number;
  modelUsage: ModelUsage;
  oracle: {
    labelStatus: ExternalBenchmarkOracleEntry["labelStatus"];
    adjudicationVersion: string;
    rationaleSha256: string;
  };
  declaredCaseContext: {
    expectedTask: ExternalBenchmarkCase["expectedTask"];
    observations: ExternalBenchmarkCase["observations"];
  };
  runnerReceipts: Array<{
    runner: RunnerReceipt["runner"];
    runnerVersion: string;
    receiptSha256: string;
    rawReportSha256: string;
    outcome: RunnerReceipt["outcome"];
  }>;
}

export type ExternalBenchmarkResult = ExternalBenchmarkResultBase & ({
  execution: "completed";
  report: DebugReport;
  score: ExternalBenchmarkScore;
  error: null;
} | {
  execution: "case_error";
  report: null;
  score: null;
  error: { stage: "preflight" | "execute"; code: string };
});

export interface ExternalBenchmarkReport {
  schemaVersion: "a-pidoc.external-benchmark-report/v1";
  dataset: { id: string; version: string; casesSha256: string; oracleSha256: string; declaredManifestSha256: string };
  scoring: "external-oracle-v1";
  paired: boolean;
  passed: boolean;
  arms: Array<{ id: string; runtime: Reasoner["runtime"] }>;
  results: ExternalBenchmarkResult[];
}

function assertRuntimeBoundary(item: ExternalBenchmarkCase, allowedHosts: ReadonlySet<string>, allowedPorts: ReadonlySet<number>): void {
  const host = item.target.host.toLowerCase();
  if (!allowedHosts.has(host)) throw new Error(`BLOCKED_BENCHMARK_HOST: ${host}`);
  if (!allowedPorts.has(item.target.port)) throw new Error(`BLOCKED_BENCHMARK_PORT: ${item.target.port}`);
}

function totalModelUsage(report: DebugReport): ModelUsage {
  return report.attempts.reduce<ModelUsage>((total, attempt) => {
    const usage = attempt.diagnosis?.modelUsage;
    return usage ? {
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
      estimatedCostUsd: total.estimatedCostUsd + usage.estimatedCostUsd
    } : total;
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });
}

function score(report: DebugReport, oracle: ExternalBenchmarkOracleEntry): ExternalBenchmarkScore {
  const rootCauseMatched = oracle.acceptableRootCauses.includes(report.rootCause);
  const statusMatched = oracle.acceptableStatuses.includes(report.status);
  const attemptsMatched = report.attempts.length >= oracle.minAttempts && report.attempts.length <= oracle.maxAttempts;
  const evidenceMatched = !oracle.requireEvidenceComplete || report.evaluation.evidenceComplete;
  return { passed: rootCauseMatched && statusMatched && attemptsMatched && evidenceMatched, rootCauseMatched, statusMatched, attemptsMatched, evidenceMatched };
}

async function receiptsForCase(ownerPath: string, item: ExternalBenchmarkCase): Promise<ExternalBenchmarkResult["runnerReceipts"]> {
  const receipts: ExternalBenchmarkResult["runnerReceipts"] = [];
  for (const reference of item.runnerReceipts ?? []) {
    const loaded = await loadRunnerReceipt(resolveContainedFile(ownerPath, reference.path));
    if (loaded.sha256 !== reference.sha256) throw new Error(`RUNNER_RECEIPT_HASH_MISMATCH: ${item.id}`);
    if (loaded.value.runner !== reference.runner || loaded.value.caseId !== item.id) throw new Error(`RUNNER_RECEIPT_IDENTITY_MISMATCH: ${item.id}`);
    receipts.push({
      runner: loaded.value.runner,
      runnerVersion: loaded.value.runnerVersion,
      receiptSha256: loaded.sha256,
      rawReportSha256: loaded.value.rawReportSha256,
      outcome: loaded.value.outcome
    });
  }
  return receipts;
}

function oracleIdentity(oracle: ExternalBenchmarkOracleEntry): ExternalBenchmarkResult["oracle"] {
  return { labelStatus: oracle.labelStatus, adjudicationVersion: oracle.adjudicationVersion, rationaleSha256: oracle.rationaleSha256 };
}

function declaredCaseContext(item: ExternalBenchmarkCase): ExternalBenchmarkResult["declaredCaseContext"] {
  return { expectedTask: item.expectedTask, observations: structuredClone(item.observations) };
}

function safeCaseError(error: unknown, stage: "preflight" | "execute"): { stage: "preflight" | "execute"; code: string } {
  const message = error instanceof Error ? error.message : "";
  const candidate = message.split(":", 1)[0] ?? "";
  const known = new Set([
    "BLOCKED_BENCHMARK_HOST", "BLOCKED_BENCHMARK_PORT", "RUNNER_RECEIPT_HASH_MISMATCH",
    "RUNNER_RECEIPT_IDENTITY_MISMATCH", "RECEIPT_PATH_OUTSIDE_DATASET", "INVALID_CONTRACT", "INVALID_JSON"
  ]);
  return { stage, code: known.has(candidate) ? candidate : "BENCHMARK_CASE_ERROR" };
}

const zeroUsage = (): ModelUsage => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0 });

export async function evaluateExternalBenchmark(options: ExternalBenchmarkOptions): Promise<ExternalBenchmarkReport> {
  if (options.allowedHosts.length === 0 || options.allowedPorts.length === 0) throw new Error("EXPLICIT_BENCHMARK_ALLOWLIST_REQUIRED");
  const [loadedCases, loadedOracle] = await Promise.all([
    loadExternalBenchmarkCases(options.casesPath),
    loadExternalBenchmarkOracle(options.oraclePath)
  ]);
  assertCaseOraclePair(loadedCases.value, loadedOracle.value);
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
  const allowedPorts = new Set(options.allowedPorts);
  const arms = options.arms ?? [{ id: "deterministic", reasoner: new DeterministicReasoner() }];
  if (arms.length < 1 || arms.length > 2) throw new Error("BENCHMARK_REQUIRES_ONE_OR_TWO_ARMS");
  if (new Set(arms.map((arm) => arm.id)).size !== arms.length) throw new Error("DUPLICATE_BENCHMARK_ARM");

  const oracleById = new Map(loadedOracle.value.cases.map((item) => [item.id, item]));
  const results: ExternalBenchmarkResult[] = [];
  for (const [caseIndex, visibleCase] of (loadedCases.value.cases as ExternalBenchmarkCase[]).entries()) {
    const oracle = oracleById.get(visibleCase.id)!;
    const orderedArms = caseIndex % 2 === 0 ? arms : [...arms].reverse();
    let receipts: ExternalBenchmarkResult["runnerReceipts"];
    const preflightStarted = performance.now();
    try {
      assertRuntimeBoundary(visibleCase, allowedHosts, allowedPorts);
      receipts = await receiptsForCase(loadedCases.path, visibleCase);
    } catch (error) {
      const failure = safeCaseError(error, "preflight");
      for (const arm of orderedArms) results.push({
        caseId: visibleCase.id,
        armId: arm.id,
        runtime: arm.reasoner.runtime,
        execution: "case_error",
        report: null,
        score: null,
        error: failure,
        durationMs: Math.max(1, Math.round(performance.now() - preflightStarted)),
        modelUsage: zeroUsage(),
        oracle: oracleIdentity(oracle),
        declaredCaseContext: declaredCaseContext(visibleCase),
        runnerReceipts: []
      });
      continue;
    }
    for (const arm of orderedArms) {
      const started = performance.now();
      try {
        // Only the visible task crosses the execution boundary. The oracle stays
        // in this evaluator and is consulted after the report has been produced.
        const report = await createRealAppWithReasoner({ allowedHosts, allowedPorts }, arm.reasoner).run(structuredClone(visibleCase.task));
        results.push({
          caseId: visibleCase.id,
          armId: arm.id,
          runtime: arm.reasoner.runtime,
          execution: "completed",
          report,
          score: score(report, oracle),
          error: null,
          durationMs: Math.max(1, Math.round(performance.now() - started)),
          modelUsage: totalModelUsage(report),
          oracle: oracleIdentity(oracle),
          declaredCaseContext: declaredCaseContext(visibleCase),
          runnerReceipts: structuredClone(receipts)
        });
      } catch (error) {
        results.push({
          caseId: visibleCase.id,
          armId: arm.id,
          runtime: arm.reasoner.runtime,
          execution: "case_error",
          report: null,
          score: null,
          error: safeCaseError(error, "execute"),
          durationMs: Math.max(1, Math.round(performance.now() - started)),
          modelUsage: zeroUsage(),
          oracle: oracleIdentity(oracle),
          declaredCaseContext: declaredCaseContext(visibleCase),
          runnerReceipts: structuredClone(receipts)
        });
      }
    }
  }
  const paired = arms.length === 2 && loadedCases.value.cases.every((item) => arms.every((arm) => results.some((result) => result.caseId === item.id && result.armId === arm.id)));
  return {
    schemaVersion: "a-pidoc.external-benchmark-report/v1",
    dataset: {
      id: loadedCases.value.dataset.id,
      version: loadedCases.value.dataset.version,
      casesSha256: loadedCases.sha256,
      oracleSha256: loadedOracle.sha256,
      declaredManifestSha256: loadedCases.value.dataset.manifestSha256
    },
    scoring: "external-oracle-v1",
    paired,
    passed: results.every((result) => result.execution === "completed" && result.score.passed),
    arms: arms.map((arm) => ({ id: arm.id, runtime: arm.reasoner.runtime })),
    results
  };
}
