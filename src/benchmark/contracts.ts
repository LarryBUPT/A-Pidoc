import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import type { DebugTask, RootCause } from "../domain/types.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase SHA-256 digest");
const nonEmpty = z.string().trim().min(1).max(500);
const httpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const rootCause = z.enum([
  "AUTH_HEADER_FORMAT", "CONTENT_TYPE_MISMATCH", "BODY_TYPE_MISMATCH", "HTTP_METHOD_MISMATCH",
  "RATE_LIMIT_TRANSIENT", "AUTH_EXPIRED", "PERMISSION_DENIED", "ENDPOINT_NOT_FOUND",
  "BODY_FIELD_MISSING", "BODY_ENUM_MISMATCH", "SERVER_ERROR", "REQUEST_TIMEOUT", "NETWORK_ERROR",
  "INVALID_JSON_RESPONSE", "NONE", "UNKNOWN"
]);

const manifestEntrySchema = z.strictObject({
  sourceId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  documentUrl: z.url().refine((value) => new URL(value).protocol === "https:", "documentUrl must use HTTPS"),
  sourceRepository: z.url().refine((value) => new URL(value).protocol === "https:", "sourceRepository must use HTTPS"),
  openApiMajor: z.union([z.literal(2), z.literal(3)]),
  domain: nonEmpty,
  preferredVersion: nonEmpty,
  retrievedAt: z.iso.datetime({ offset: true }),
  sha256,
  bytes: z.number().int().positive().max(1_000_000),
  license: z.strictObject({
    spdx: nonEmpty,
    termsUrl: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
  }),
  permissions: z.strictObject({ parse: z.literal(true), localExecution: z.boolean() }),
  expectedPolicy: z.enum(["supported", "unsupported-classified", "quarantined"])
});

const manifestSchema = z.strictObject({
  schemaVersion: z.literal("a-pidoc.external-openapi-manifest/v1"),
  corpus: z.strictObject({
    name: nonEmpty,
    source: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
    version: nonEmpty,
    retrievedAt: z.iso.datetime({ offset: true })
  }),
  entries: z.array(manifestEntrySchema).min(1).max(100)
}).superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (ids.has(entry.sourceId)) context.addIssue({ code: "custom", path: ["entries", index, "sourceId"], message: "duplicate manifest entry id" });
    ids.add(entry.sourceId);
  }
});

const requestSchema = z.strictObject({
  method: httpMethod,
  url: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)),
  headers: z.record(z.string(), z.string()),
  body: z.record(z.string(), z.unknown()).nullable()
});

const specSchema = z.strictObject({
  method: httpMethod,
  requiredHeaders: z.record(z.string(), z.string()),
  requiredBody: z.record(z.string(), z.enum(["string", "number", "boolean"])),
  bodySchema: z.record(z.string(), z.unknown()).optional()
});

const taskSchema = z.strictObject({
  id: nonEmpty,
  title: nonEmpty,
  source: z.literal("openapi"),
  request: requestSchema,
  spec: specSchema
});

const receiptReferenceSchema = z.strictObject({
  runner: z.enum(["hurl", "schemathesis"]),
  path: z.string().trim().min(1).max(500),
  sha256
});

const benchmarkCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  title: nonEmpty,
  identity: z.strictObject({ source: nonEmpty, version: nonEmpty, sourceSha256: sha256 }),
  environment: z.strictObject({
    imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    seed: nonEmpty,
    allowedHost: nonEmpty,
    allowedPort: z.number().int().min(1).max(65535)
  }),
  task: taskSchema,
  target: z.strictObject({ host: nonEmpty, port: z.number().int().min(1).max(65535) }),
  openApi: z.strictObject({ manifestEntryId: nonEmpty, sha256 }),
  sideEffectFree: z.literal(true),
  observations: z.array(z.strictObject({ sequence: z.number().int().positive(), kind: nonEmpty, artifactSha256: sha256 })).max(100),
  expectedTask: z.enum(["diagnosis", "validation"]),
  provenance: z.strictObject({ generator: nonEmpty, adjudicator: nonEmpty, createdAt: z.iso.datetime({ offset: true }) }),
  runnerReceipts: z.array(receiptReferenceSchema).max(10).optional()
}).superRefine((value, context) => {
  const url = new URL(value.task.request.url);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (url.hostname.toLowerCase() !== value.target.host.toLowerCase() || port !== value.target.port) {
    context.addIssue({ code: "custom", path: ["target"], message: "target must exactly match task.request.url" });
  }
  if (value.environment.allowedHost.toLowerCase() !== value.target.host.toLowerCase() || value.environment.allowedPort !== value.target.port) {
    context.addIssue({ code: "custom", path: ["environment"], message: "environment allowlist must exactly match target" });
  }
  if (value.task.request.method !== "GET" || value.task.spec.method !== "GET") {
    context.addIssue({ code: "custom", path: ["task"], message: "paired external benchmark v1 accepts side-effect-free GET tasks only" });
  }
});

const caseFileSchema = z.strictObject({
  schemaVersion: z.literal("a-pidoc.external-benchmark-cases/v1"),
  dataset: z.strictObject({ id: nonEmpty, version: nonEmpty, manifestSha256: sha256 }),
  cases: z.array(benchmarkCaseSchema).min(1).max(100)
}).superRefine((value, context) => addUniqueCaseIssues(value.cases, context));

const oracleEntrySchema = z.strictObject({
  id: nonEmpty,
  labelStatus: z.enum(["gold", "unresolved", "invalid-case", "environment-failure"]),
  adjudicationVersion: nonEmpty,
  rationaleSha256: sha256,
  acceptableRootCauses: z.array(rootCause).min(1),
  acceptableStatuses: z.array(z.enum(["resolved", "unresolved", "blocked"])).min(1),
  minAttempts: z.number().int().min(0).max(5),
  maxAttempts: z.number().int().min(0).max(5),
  requireEvidenceComplete: z.boolean()
}).refine((value) => value.minAttempts <= value.maxAttempts, { message: "minAttempts must not exceed maxAttempts" });

const oracleFileSchema = z.strictObject({
  schemaVersion: z.literal("a-pidoc.external-benchmark-oracle/v1"),
  datasetId: nonEmpty,
  cases: z.array(oracleEntrySchema).min(1).max(100)
}).superRefine((value, context) => addUniqueCaseIssues(value.cases, context));

const runnerReceiptSchema = z.strictObject({
  schemaVersion: z.literal("a-pidoc.runner-receipt/v1"),
  runner: z.enum(["hurl", "schemathesis"]),
  runnerVersion: nonEmpty,
  caseId: nonEmpty,
  rawReportSha256: sha256,
  exitCode: z.number().int().min(0).max(255),
  outcome: z.enum(["passed", "failed", "error"]),
  observations: z.strictObject({
    requests: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative()
  })
});

function addUniqueCaseIssues(items: readonly { id: string }[], context: z.core.$RefinementCtx): void {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) context.addIssue({ code: "custom", path: ["cases", index, "id"], message: "duplicate case id" });
    ids.add(item.id);
  }
}

export type ExternalOpenApiManifest = z.infer<typeof manifestSchema>;
export type ExternalOpenApiManifestEntry = z.infer<typeof manifestEntrySchema>;
export type ExternalBenchmarkCaseFile = z.infer<typeof caseFileSchema>;
export type ExternalBenchmarkCase = z.infer<typeof benchmarkCaseSchema> & { task: DebugTask };
export type ExternalBenchmarkOracleFile = z.infer<typeof oracleFileSchema>;
export type ExternalBenchmarkOracleEntry = z.infer<typeof oracleEntrySchema> & { acceptableRootCauses: RootCause[] };
export type RunnerReceipt = z.infer<typeof runnerReceiptSchema>;

export interface LoadedJson<T> {
  path: string;
  sha256: string;
  value: T;
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function loadJson<T>(path: string, schema: z.ZodType<T>): Promise<LoadedJson<T>> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`INVALID_JSON: ${path}`); }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`INVALID_CONTRACT: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  return { path: resolve(path), sha256: sha256Text(raw), value: result.data };
}

export function loadExternalOpenApiManifest(path: string): Promise<LoadedJson<ExternalOpenApiManifest>> {
  return loadJson(path, manifestSchema);
}

export function loadExternalBenchmarkCases(path: string): Promise<LoadedJson<ExternalBenchmarkCaseFile>> {
  return loadJson(path, caseFileSchema);
}

export function loadExternalBenchmarkOracle(path: string): Promise<LoadedJson<ExternalBenchmarkOracleFile>> {
  return loadJson(path, oracleFileSchema);
}

export async function loadRunnerReceipt(path: string): Promise<LoadedJson<RunnerReceipt>> {
  return loadJson(path, runnerReceiptSchema);
}

export function resolveContainedFile(ownerPath: string, candidate: string): string {
  if (isAbsolute(candidate)) throw new Error("RECEIPT_PATH_OUTSIDE_DATASET");
  const root = dirname(resolve(ownerPath));
  const target = resolve(root, candidate);
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error("RECEIPT_PATH_OUTSIDE_DATASET");
  return target;
}

export function assertCaseOraclePair(cases: ExternalBenchmarkCaseFile, oracle: ExternalBenchmarkOracleFile): void {
  if (cases.dataset.id !== oracle.datasetId) throw new Error("DATASET_ORACLE_ID_MISMATCH");
  const visibleIds = new Set(cases.cases.map((item) => item.id));
  const oracleIds = new Set(oracle.cases.map((item) => item.id));
  if (visibleIds.size !== oracleIds.size || [...visibleIds].some((id) => !oracleIds.has(id))) {
    throw new Error("DATASET_ORACLE_CASE_MISMATCH");
  }
}
