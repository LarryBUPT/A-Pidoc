import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import test from "node:test";
import { scanRepository } from "../src/repository/scanner.js";

const fixtureRoot = resolve("test/fixtures/repository");

async function fixtureSpec(): Promise<unknown> {
  return JSON.parse(await readFile(resolve(fixtureRoot, "openapi.json"), "utf8"));
}

test("repository preflight maps literal fetch calls to OpenAPI operations and source lines", async () => {
  const report = await scanRepository({ root: fixtureRoot, openApiDocument: await fixtureSpec() });
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.apiCalls.length, 2);
  assert.deepEqual(
    report.apiCalls.map(({ method, openApiOperation, file, line }) => ({ method, openApiOperation, file, line })),
    [
      { method: "POST", openApiOperation: "POST /orders", file: "src/client.ts", line: 2 },
      { method: "DELETE", openApiOperation: null, file: "src/client.ts", line: 7 }
    ]
  );
  assert.equal(report.summary.matchedOperations, 1);
  assert.equal(report.summary.errors, 1);
});

test("repository preflight reports undeclared environment variables and dynamic fetch without reading .env", async () => {
  const report = await scanRepository({ root: fixtureRoot, openApiDocument: await fixtureSpec() });
  assert.deepEqual(
    report.environmentReferences.map(({ name, declaredInExample }) => ({ name, declaredInExample })),
    [
      { name: "API_BASE", declaredInExample: false },
      { name: "DECLARED_TOKEN", declaredInExample: true },
      { name: "MISSING_TOKEN", declaredInExample: false }
    ]
  );
  assert.equal(report.findings.filter(({ code }) => code === "ENV_NOT_DECLARED").length, 2);
  assert.equal(report.findings.filter(({ code }) => code === "DYNAMIC_FETCH_UNSUPPORTED").length, 1);
});

test("repository preflight enforces file and document limits", async () => {
  const document = await fixtureSpec();
  await assert.rejects(
    () => scanRepository({ root: fixtureRoot, openApiDocument: document, maxFiles: 0 }),
    /maxFiles/
  );
  await assert.rejects(
    () => scanRepository({ root: fixtureRoot, openApiDocument: {}, maxFiles: 10 }),
    /OpenAPI/
  );
});

test("repo CLI emits the fixed report without constructing a Pi reasoner", async () => {
  const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult) => {
    const child = spawn(process.execPath, [
      "dist/src/cli.js",
      "repo",
      "--root",
      fixtureRoot,
      "--document",
      resolve(fixtureRoot, "openapi.json")
    ], {
      env: { ...process.env, A_PIDOC_REASONER: "pi", A_PIDOC_PI_API_KEY: "" }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
  assert.equal(output.code, 1, output.stderr);
  const report = JSON.parse(output.stdout) as { summary: { calls: number; errors: number } };
  assert.deepEqual(report.summary, { calls: 2, matchedOperations: 1, errors: 1, warnings: 2 });
});

test("repository preflight ignores dependency/build directories and never treats .env as declarations", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "a-pidoc-repo-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, "src"));
  await mkdir(resolve(root, "node_modules"));
  await mkdir(resolve(root, "dist"));
  await writeFile(resolve(root, "src/index.js"), "fetch('https://api.example.test/health'); process.env.PRIVATE_ONLY;", "utf8");
  await writeFile(resolve(root, "node_modules/leak.js"), "fetch('https://api.example.test/leak');", "utf8");
  await writeFile(resolve(root, "dist/generated.js"), "fetch('https://api.example.test/generated');", "utf8");
  await writeFile(resolve(root, ".env"), "PRIVATE_ONLY=must-not-be-read\n", "utf8");
  const report = await scanRepository({
    root,
    openApiDocument: { openapi: "3.0.3", paths: { "/health": { get: {} } } }
  });
  assert.equal(report.scannedFiles, 1);
  assert.equal(report.apiCalls.length, 1);
  assert.equal(report.environmentReferences[0]?.declaredInExample, false);
});
