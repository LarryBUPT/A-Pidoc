import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { DeterministicReasoner } from "../src/agent/deterministic-reasoner.js";
import type { Reasoner } from "../src/domain/types.js";
import {
  loadExternalBenchmarkCases,
  loadExternalOpenApiManifest,
  loadRunnerReceipt,
  sha256Text
} from "../src/benchmark/contracts.js";
import { createManifestDocumentLoader, probeExternalOpenApiCorpus } from "../src/benchmark/corpus-probe.js";
import { evaluateExternalBenchmark } from "../src/benchmark/external-eval.js";
import { createRunnerReceipt, writeRunnerReceipt } from "../src/benchmark/runner-receipt.js";

const HASH = "a".repeat(64);

async function jsonFile(directory: string, name: string, value: unknown): Promise<{ path: string; raw: string; hash: string }> {
  const path = join(directory, name);
  const raw = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, raw, "utf8");
  return { path, raw, hash: sha256Text(raw) };
}

function manifest(entries: unknown[]): unknown {
  return {
    schemaVersion: "a-pidoc.external-openapi-manifest/v1",
    corpus: { name: "fixture", source: "https://example.test/index.json", version: "2026-09-21", retrievedAt: "2026-09-21T00:00:00+00:00" },
    entries
  };
}

function entry(id: string, raw: string): unknown {
  return {
    sourceId: id,
    documentUrl: `https://example.test/${id}.json`,
    sourceRepository: "https://github.com/example/api",
    openApiMajor: 3,
    domain: "fixture",
    preferredVersion: "v1",
    retrievedAt: "2026-09-21T00:00:00+00:00",
    sha256: sha256Text(raw),
    bytes: Buffer.byteLength(raw),
    license: { spdx: "Apache-2.0", termsUrl: "https://example.test/license" },
    permissions: { parse: true, localExecution: false },
    expectedPolicy: "supported"
  };
}

function cases(port: number, receipt?: { hash: string; path: string }): unknown {
  return {
    schemaVersion: "a-pidoc.external-benchmark-cases/v1",
    dataset: { id: "directus-auth", version: "1", manifestSha256: HASH },
    cases: [{
      id: "auth-format",
      title: "Repair a malformed auth scheme",
      identity: { source: "directus", version: "11.12.0", sourceSha256: HASH },
      environment: { imageDigest: `sha256:${HASH}`, seed: "orders-v1", allowedHost: "127.0.0.1", allowedPort: port },
      task: {
        id: "auth-format",
        title: "Repair a malformed auth scheme",
        source: "openapi",
        request: { method: "GET", url: `http://127.0.0.1:${port}/protected`, headers: { Authorization: "test-token" }, body: null },
        spec: { method: "GET", requiredHeaders: { Authorization: "Bearer test-token" }, requiredBody: {} }
      },
      target: { host: "127.0.0.1", port },
      openApi: { manifestEntryId: "directus", sha256: HASH },
      sideEffectFree: true,
      observations: [],
      expectedTask: "diagnosis",
      provenance: { generator: "controlled-mutation", adjudicator: "fixture-owner", createdAt: "2026-09-21T00:00:00+00:00" },
      ...(receipt ? { runnerReceipts: [{ runner: "hurl", path: receipt.path, sha256: receipt.hash }] } : {})
    }]
  };
}

function oracle(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: "a-pidoc.external-benchmark-oracle/v1",
    datasetId: "directus-auth",
    cases: [{ id: "auth-format", labelStatus: "gold", adjudicationVersion: "1", rationaleSha256: HASH, acceptableRootCauses: ["AUTH_HEADER_FORMAT"], acceptableStatuses: ["resolved"], minAttempts: 2, maxAttempts: 2, requireEvidenceComplete: true, ...overrides }]
  };
}

async function fixtureServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/protected" && request.headers.authorization === "Bearer test-token") {
      response.writeHead(200).end('{"ok":true}');
    } else {
      response.writeHead(401).end('{"error":"invalid authorization format"}');
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a port");
  return { server, port: address.port };
}

test("external manifest is strict, bounded, and rejects unknown fields", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-contract-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const spec = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}';
  const valid = await jsonFile(directory, "manifest.json", manifest([entry("one", spec)]));
  assert.equal((await loadExternalOpenApiManifest(valid.path)).value.entries.length, 1);
  const invalidValue = manifest([{ ...(entry("one", spec) as Record<string, unknown>), unexpected: true }]);
  const invalid = await jsonFile(directory, "invalid.json", invalidValue);
  await assert.rejects(loadExternalOpenApiManifest(invalid.path), /INVALID_CONTRACT.*unrecognized/i);
});

test("runner adapter hashes raw evidence, derives outcome, and refuses overwrite", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-runner-receipt-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const raw = await jsonFile(directory, "raw-report.json", { runnerMessage: "HTTP 500 is not a root-cause label" });
  const receipt = await createRunnerReceipt({ runner: "schemathesis", runnerVersion: "4.5.0", caseId: "case-1", rawReportPath: raw.path, exitCode: 1, requests: 3, failures: 1 });
  assert.equal(receipt.rawReportSha256, raw.hash);
  assert.equal(receipt.outcome, "failed");
  const output = join(directory, "receipt.json");
  await writeRunnerReceipt(output, receipt);
  await assert.rejects(writeRunnerReceipt(output, receipt), /EEXIST/);
  await assert.rejects(
    createRunnerReceipt({ runner: "hurl", runnerVersion: "6.1.1", caseId: "case-1", rawReportPath: raw.path, exitCode: 0, requests: 1, failures: 2 }),
    /RUNNER_FAILURES_EXCEED_REQUESTS/
  );
});

test("corpus probe keeps fetch, integrity, unsupported, and parsed outcomes separate and continues", async () => {
  const parsed = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{"/x":{"get":{}}}}';
  const unsupported = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{},"components":{"schemas":{"x":{"$ref":"https://example.test/x.json"}}}}';
  const parsedEntry = entry("parsed", parsed) as ReturnType<typeof entry> & { sourceId: string };
  const unsupportedEntry = entry("unsupported", unsupported) as ReturnType<typeof entry> & { sourceId: string };
  const integrityEntry = { ...(entry("integrity", parsed) as Record<string, unknown>), sha256: HASH };
  const value = manifest([parsedEntry, { ...(entry("fetch", parsed) as Record<string, unknown>) }, integrityEntry, unsupportedEntry]);
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-probe-"));
  try {
    const file = await jsonFile(directory, "manifest.json", value);
    const loaded = await loadExternalOpenApiManifest(file.path);
    const report = await probeExternalOpenApiCorpus(loaded.value, async (item) => {
      if (item.sourceId === "fetch") throw new Error("network unavailable");
      return new TextEncoder().encode(item.sourceId === "unsupported" ? unsupported : parsed);
    });
    assert.deepEqual(report.results.map((result) => [result.id, result.status, result.code]), [
      ["parsed", "parsed", "PARSED"],
      ["fetch", "fetch_failed", "FETCH_FAILED"],
      ["integrity", "integrity_failed", "SHA256_MISMATCH"],
      ["unsupported", "unsupported", "UNSUPPORTED_EXTERNAL_REF"]
    ]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("default corpus loader requires an explicit host allowlist before making a connection", async (context) => {
  let connections = 0;
  const server = createServer();
  server.on("connection", () => { connections += 1; });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => server.close());
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a port");
  const raw = '{}';
  const item = { ...(entry("blocked", raw) as Record<string, unknown>), documentUrl: `https://127.0.0.1:${address.port}/internal.json` };
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-policy-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const file = await jsonFile(directory, "manifest.json", manifest([item]));
  const loaded = await loadExternalOpenApiManifest(file.path);
  const report = await probeExternalOpenApiCorpus(loaded.value, createManifestDocumentLoader(["api.apis.guru"]));
  assert.equal(report.results[0]?.code, "FETCH_BLOCKED_HOST");
  assert.equal(connections, 0);
  assert.throws(() => createManifestDocumentLoader([]), /EXPLICIT_CORPUS_ALLOWLIST_REQUIRED/);
});

test("paired external evaluation keeps the oracle out of reasoner input and ignores runner pass as truth", async (context) => {
  const { server, port } = await fixtureServer();
  context.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-eval-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await jsonFile(directory, "hurl-receipt.json", {
    schemaVersion: "a-pidoc.runner-receipt/v1",
    runner: "hurl",
    runnerVersion: "6.1.1",
    caseId: "auth-format",
    rawReportSha256: "b".repeat(64),
    exitCode: 0,
    outcome: "passed",
    observations: { requests: 1, failures: 0 }
  });
  const caseFile = await jsonFile(directory, "cases.json", cases(port, { path: "hurl-receipt.json", hash: receipt.hash }));
  const oracleFile = await jsonFile(directory, "oracle.json", oracle());
  let inspected = false;
  const base = new DeterministicReasoner();
  const inspectingReasoner: Reasoner = {
    runtime: base.runtime,
    diagnose: async (input) => {
      inspected = true;
      assert.equal("acceptableRootCauses" in (input as unknown as Record<string, unknown>), false);
      assert.doesNotMatch(JSON.stringify(input), /AUTH_HEADER_FORMAT.*acceptableStatuses/);
      return base.diagnose(input);
    }
  };
  const report = await evaluateExternalBenchmark({
    casesPath: caseFile.path,
    oraclePath: oracleFile.path,
    allowedHosts: ["127.0.0.1"],
    allowedPorts: [port],
    arms: [{ id: "deterministic", reasoner: base }, { id: "candidate", reasoner: inspectingReasoner }]
  });
  assert.equal(inspected, true);
  assert.equal(report.paired, true);
  assert.equal(report.passed, true);
  assert.equal(report.results.length, 2);
  assert.ok(report.results.every((result) => result.execution === "completed" && result.report.attempts.length === 2 && result.score.passed));
  assert.ok(report.results.every((result) => result.runnerReceipts[0]?.outcome === "passed"));
  assert.ok(report.results.every((result) => result.oracle.labelStatus === "gold" && result.oracle.rationaleSha256 === HASH));
  assert.equal(report.dataset.declaredManifestSha256, HASH);

  const wrongOracle = await jsonFile(directory, "wrong-oracle.json", oracle({ acceptableRootCauses: ["PERMISSION_DENIED"] }));
  const falsePositive = await evaluateExternalBenchmark({ casesPath: caseFile.path, oraclePath: wrongOracle.path, allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
  assert.equal(falsePositive.passed, false, "a passing Hurl receipt must not override external oracle scoring");
});

test("external evaluation records per-case boundary and receipt failures without losing the batch", async (context) => {
  const { server, port } = await fixtureServer();
  context.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-negative-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const receipt = await jsonFile(directory, "receipt.json", {
    schemaVersion: "a-pidoc.runner-receipt/v1", runner: "schemathesis", runnerVersion: "4.5.0", caseId: "auth-format",
    rawReportSha256: HASH, exitCode: 1, outcome: "failed", observations: { requests: 2, failures: 1 }
  });
  const validCases = await jsonFile(directory, "cases.json", cases(port, { path: "receipt.json", hash: receipt.hash }));
  const oracleFile = await jsonFile(directory, "oracle.json", oracle());
  const blockedHost = await evaluateExternalBenchmark({ casesPath: validCases.path, oraclePath: oracleFile.path, allowedHosts: ["localhost"], allowedPorts: [port] });
  assert.equal(blockedHost.passed, false);
  assert.equal(blockedHost.results[0]?.execution, "case_error");
  assert.equal(blockedHost.results[0]?.error?.code, "BLOCKED_BENCHMARK_HOST");
  await writeFile(receipt.path, `${receipt.raw} `, "utf8");
  const tampered = await evaluateExternalBenchmark({ casesPath: validCases.path, oraclePath: oracleFile.path, allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
  assert.equal(tampered.results[0]?.error?.code, "RUNNER_RECEIPT_HASH_MISMATCH");
  await writeFile(receipt.path, '{"unexpected":true}', "utf8");
  await assert.rejects(loadRunnerReceipt(receipt.path), /INVALID_CONTRACT/);

  const unsafe = cases(port) as { cases: Array<Record<string, unknown>> };
  unsafe.cases[0]!.runnerReceipts = [{ runner: "hurl", path: "../outside.json", sha256: HASH }];
  const unsafeFile = await jsonFile(directory, "unsafe.json", unsafe);
  const escaped = await evaluateExternalBenchmark({ casesPath: unsafeFile.path, oraclePath: oracleFile.path, allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
  assert.equal(escaped.results[0]?.error?.code, "RECEIPT_PATH_OUTSIDE_DATASET");

  const mutable = cases(port) as { cases: Array<{ task: { request: { method: string }; spec: { method: string } } }> };
  mutable.cases[0]!.task.request.method = "POST";
  mutable.cases[0]!.task.spec.method = "POST";
  const mutableFile = await jsonFile(directory, "mutable.json", mutable);
  await assert.rejects(loadExternalBenchmarkCases(mutableFile.path), /side-effect-free GET tasks only/);
});

test("external evaluation preserves completed cases when a later case fails preflight", async (context) => {
  const { server, port } = await fixtureServer();
  context.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-partial-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const caseValue = cases(port) as { cases: Array<Record<string, unknown>> };
  const blockedPort = port === 65535 ? 65534 : port + 1;
  const blocked = structuredClone(caseValue.cases[0]!) as Record<string, any>;
  blocked.id = "blocked-port";
  blocked.task.id = "blocked-port";
  blocked.task.request.url = `http://127.0.0.1:${blockedPort}/protected`;
  blocked.target.port = blockedPort;
  blocked.environment.allowedPort = blockedPort;
  caseValue.cases.push(blocked);
  const oracleValue = oracle() as { cases: Array<Record<string, unknown>> };
  oracleValue.cases.push({ ...structuredClone(oracleValue.cases[0]!), id: "blocked-port" });
  const caseFile = await jsonFile(directory, "cases.json", caseValue);
  const oracleFile = await jsonFile(directory, "oracle.json", oracleValue);
  const report = await evaluateExternalBenchmark({ casesPath: caseFile.path, oraclePath: oracleFile.path, allowedHosts: ["127.0.0.1"], allowedPorts: [port] });
  assert.equal(report.passed, false);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0]?.execution, "completed");
  assert.equal(report.results[0]?.score?.passed, true);
  assert.equal(report.results[1]?.execution, "case_error");
  assert.equal(report.results[1]?.error?.code, "BLOCKED_BENCHMARK_PORT");
});

test("external scoring independently rejects status, attempt, and evidence mismatches", async (context) => {
  const { server, port } = await fixtureServer();
  context.after(() => server.close());
  const directory = await mkdtemp(join(tmpdir(), "a-pidoc-benchmark-score-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const caseFile = await jsonFile(directory, "cases.json", cases(port));
  const run = async (name: string, overrides: Record<string, unknown>, reasoner: Reasoner = new DeterministicReasoner()) => {
    const oracleFile = await jsonFile(directory, `${name}.json`, oracle(overrides));
    const report = await evaluateExternalBenchmark({ casesPath: caseFile.path, oraclePath: oracleFile.path, allowedHosts: ["127.0.0.1"], allowedPorts: [port], arms: [{ id: name, reasoner }] });
    const result = report.results[0];
    assert.equal(result?.execution, "completed");
    if (!result || result.execution !== "completed") throw new Error("expected completed benchmark result");
    return result.score;
  };
  const status = await run("status", { acceptableStatuses: ["blocked"] });
  assert.deepEqual(status, { passed: false, rootCauseMatched: true, statusMatched: false, attemptsMatched: true, evidenceMatched: true });
  const attempts = await run("attempts", { minAttempts: 1, maxAttempts: 1 });
  assert.deepEqual(attempts, { passed: false, rootCauseMatched: true, statusMatched: true, attemptsMatched: false, evidenceMatched: true });
  const base = new DeterministicReasoner();
  const incompleteEvidence: Reasoner = { runtime: base.runtime, diagnose: async (input) => ({ ...await base.diagnose(input), evidence: [] }) };
  const evidence = await run("evidence", { acceptableStatuses: ["unresolved"] }, incompleteEvidence);
  assert.deepEqual(evidence, { passed: false, rootCauseMatched: true, statusMatched: true, attemptsMatched: true, evidenceMatched: false });
});
