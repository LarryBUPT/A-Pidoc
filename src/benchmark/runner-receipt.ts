import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RunnerReceipt } from "./contracts.js";

export interface RunnerReceiptInput {
  runner: RunnerReceipt["runner"];
  runnerVersion: string;
  caseId: string;
  rawReportPath: string;
  exitCode: number;
  requests: number;
  failures: number;
}

export async function createRunnerReceipt(input: RunnerReceiptInput): Promise<RunnerReceipt> {
  if (!input.runnerVersion.trim() || !input.caseId.trim()) throw new Error("RUNNER_IDENTITY_REQUIRED");
  if (!Number.isInteger(input.exitCode) || input.exitCode < 0 || input.exitCode > 255) throw new Error("INVALID_RUNNER_EXIT_CODE");
  if (![input.requests, input.failures].every((value) => Number.isInteger(value) && value >= 0)) throw new Error("INVALID_RUNNER_COUNTS");
  if (input.failures > input.requests) throw new Error("RUNNER_FAILURES_EXCEED_REQUESTS");
  const rawReport = await readFile(input.rawReportPath);
  const outcome: RunnerReceipt["outcome"] = input.exitCode === 0 && input.failures === 0 ? "passed"
    : input.requests > 0 ? "failed" : "error";
  return {
    schemaVersion: "a-pidoc.runner-receipt/v1",
    runner: input.runner,
    runnerVersion: input.runnerVersion,
    caseId: input.caseId,
    rawReportSha256: createHash("sha256").update(rawReport).digest("hex"),
    exitCode: input.exitCode,
    outcome,
    observations: { requests: input.requests, failures: input.failures }
  };
}

export async function writeRunnerReceipt(path: string, receipt: RunnerReceipt): Promise<void> {
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}
