import { readFile } from "node:fs/promises";
import { createFixtureApp, createRealApp } from "./app.js";
import type { ApiSpec } from "./domain/types.js";
import { cases, getCase } from "./fixtures/cases.js";
import { parseCurlTask } from "./input/debug-input.js";
import { parseOpenApiOperation } from "./input/openapi-parser.js";

function flags(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`Invalid option near ${name ?? "end of input"}`);
    result.set(name.slice(2), value);
  }
  return result;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

async function jsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function printReport(report: Awaited<ReturnType<ReturnType<typeof createRealApp>["run"]>>): void {
  console.log(JSON.stringify(report, null, 2));
  if (!report.evaluation.passed) process.exitCode = 1;
}

async function run(): Promise<void> {
  const [mode = "all", ...args] = process.argv.slice(2);
  if (mode === "all" || cases.some((item) => item.id === mode)) {
    const selected = mode === "all" ? cases : [getCase(mode)];
    const reports = [];
    for (const item of selected) {
      reports.push(await createFixtureApp(item).run(item, { expectedRootCause: item.expectedRootCause }));
    }
    console.table(reports.map((report) => ({
      task: report.taskId,
      status: report.status,
      rootCause: report.rootCause,
      attempts: report.attempts.length,
      passed: report.evaluation.passed
    })));
    if (reports.some((report) => !report.evaluation.passed)) process.exitCode = 1;
    return;
  }

  const options = flags(args);
  const allowedHosts = required(options, "allow-host").split(",").map((host) => host.trim()).filter(Boolean);
  if (mode === "curl") {
    const command = options.has("command")
      ? required(options, "command")
      : await readFile(required(options, "input"), "utf8");
    const task = parseCurlTask({
      kind: "curl",
      command,
      spec: await jsonFile(required(options, "spec")) as ApiSpec
    });
    printReport(await createRealApp({ allowedHosts }).run(task));
    return;
  }
  if (mode === "openapi") {
    const document = await jsonFile(required(options, "document"));
    const body = options.has("body")
      ? await jsonFile(required(options, "body")) as Record<string, unknown>
      : undefined;
    const parsed = parseOpenApiOperation(document, {
      path: required(options, "path"),
      method: required(options, "method"),
      ...(body === undefined ? {} : { body })
    });
    if (parsed.schemaIssues.length > 0) {
      throw new Error(`OpenAPI request validation failed: ${JSON.stringify(parsed.schemaIssues)}`);
    }
    printReport(await createRealApp({ allowedHosts }).run(parsed.task));
    return;
  }
  throw new Error(
    "Usage: all | <fixture-id> | curl --input file --spec file --allow-host host | openapi --document file --path /path --method POST --allow-host host"
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
