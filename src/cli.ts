import { createFixtureApp } from "./app.js";
import { cases, getCase } from "./fixtures/cases.js";

const selection = process.argv[2] ?? "all";
const selected = selection === "all" ? cases : [getCase(selection)];
const app = createFixtureApp();
const reports = [];

for (const item of selected) reports.push(await app.run(structuredClone(item)));

console.table(
  reports.map((report) => ({
    case: report.caseId,
    status: report.status,
    rootCause: report.rootCause,
    attempts: report.attempts.length,
    passed: report.evaluation.passed
  }))
);

if (reports.some((report) => !report.evaluation.passed)) process.exitCode = 1;
