import { createHash } from "node:crypto";
import { describeOpenApiDocument } from "../input/openapi-parser.js";
import { RequestPolicy } from "../security/request-policy.js";
import { PublicError } from "../security/errors.js";
import type { ExternalOpenApiManifest, ExternalOpenApiManifestEntry } from "./contracts.js";

export type CorpusProbeStatus = "parsed" | "unsupported" | "invalid" | "fetch_failed" | "integrity_failed";
export type CorpusProbeStage = "fetch" | "integrity" | "parse" | "complete";

export interface CorpusProbeResult {
  id: string;
  documentUrl: string;
  status: CorpusProbeStatus;
  stage: CorpusProbeStage;
  code: string;
  durationMs: number;
  bytes?: number;
  sha256?: string;
  operationCount?: number;
  documentFormat?: "json";
  openApiMajor?: number;
  timedOut: boolean;
  crashed: boolean;
  unexpectedWrites: boolean;
  peakResourceBytes: null;
}

export interface CorpusProbeReport {
  schemaVersion: "a-pidoc.external-openapi-probe-report/v1";
  corpus: ExternalOpenApiManifest["corpus"];
  startedAt: string;
  completedAt: string;
  results: CorpusProbeResult[];
  summary: Record<CorpusProbeStatus, number>;
}

export type ManifestDocumentLoader = (entry: ExternalOpenApiManifestEntry) => Promise<Uint8Array>;

const unsupportedPatterns: ReadonlyArray<[RegExp, string]> = [
  [/Only local OpenAPI \$ref is supported/, "UNSUPPORTED_EXTERNAL_REF"],
  [/Cyclic OpenAPI \$ref is unsupported/, "UNSUPPORTED_CYCLIC_REF"],
  [/Assertion siblings of \$ref are unsupported/, "UNSUPPORTED_REF_SIBLING"],
  [/Swagger formData is unsupported/, "UNSUPPORTED_FORM_DATA"],
  [/Only JSON Swagger request bodies are supported/, "UNSUPPORTED_NON_JSON_BODY"],
  [/API document expansion (?:byte )?limit exceeded/, "UNSUPPORTED_EXPANSION_LIMIT"],
  [/API document exceeds byte limit/, "UNSUPPORTED_DOCUMENT_SIZE"],
  [/Only OpenAPI 3\.x documents are supported/, "UNSUPPORTED_OPENAPI_VERSION"]
];

function classifyParseFailure(error: unknown): { status: "unsupported" | "invalid"; code: string } {
  const message = error instanceof Error ? error.message : "";
  for (const [pattern, code] of unsupportedPatterns) if (pattern.test(message)) return { status: "unsupported", code };
  if (/Unresolved OpenAPI \$ref/.test(message)) return { status: "invalid", code: "INVALID_UNRESOLVED_REF" };
  if (/must be an object|Duplicate OpenAPI operationId|exactly one JSON OpenAPI/.test(message)) return { status: "invalid", code: "INVALID_OPENAPI_DOCUMENT" };
  return { status: "invalid", code: "INVALID_OPENAPI_DOCUMENT" };
}

export function createManifestDocumentLoader(allowedHosts: readonly string[]): ManifestDocumentLoader {
  if (allowedHosts.length === 0) throw new Error("EXPLICIT_CORPUS_ALLOWLIST_REQUIRED");
  const policy = new RequestPolicy({ allowedHosts, allowedPorts: [443] });
  return async (entry) => {
    await policy.assertResolvedAddressAllowed({ method: "GET", url: entry.documentUrl, headers: {}, body: null });
    const response = await fetch(entry.documentUrl, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > 1_000_000) throw new Error("FETCH_SIZE_LIMIT");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 1_000_000) throw new Error("FETCH_SIZE_LIMIT");
    return bytes;
  };
}

async function probeEntry(entry: ExternalOpenApiManifestEntry, loader: ManifestDocumentLoader): Promise<CorpusProbeResult> {
  const started = performance.now();
  let bytes: Uint8Array;
  try { bytes = await loader(entry); } catch (error) {
    const timedOut = error instanceof Error && /timeout|abort/i.test(`${error.name} ${error.message}`);
    const blocked = error instanceof PublicError && ["BLOCKED_HOST", "BLOCKED_PORT", "BLOCKED_PRIVATE_ADDRESS", "BLOCKED_PROTOCOL", "EMBEDDED_CREDENTIALS"].includes(error.code);
    return { id: entry.sourceId, documentUrl: entry.documentUrl, status: "fetch_failed", stage: "fetch", code: timedOut ? "FETCH_TIMEOUT" : blocked ? `FETCH_${error.code}` : "FETCH_FAILED", durationMs: Math.max(1, Math.round(performance.now() - started)), timedOut, crashed: false, unexpectedWrites: false, peakResourceBytes: null };
  }
  const actualHash = createHash("sha256").update(bytes).digest("hex");
  const common = { id: entry.sourceId, documentUrl: entry.documentUrl, durationMs: Math.max(1, Math.round(performance.now() - started)), bytes: bytes.byteLength, sha256: actualHash, documentFormat: "json" as const, openApiMajor: entry.openApiMajor, timedOut: false, crashed: false, unexpectedWrites: false, peakResourceBytes: null };
  if (bytes.byteLength !== entry.bytes) return { ...common, status: "integrity_failed", stage: "integrity", code: "BYTE_COUNT_MISMATCH" };
  if (actualHash !== entry.sha256) return { ...common, status: "integrity_failed", stage: "integrity", code: "SHA256_MISMATCH" };
  try {
    const { description } = describeOpenApiDocument(new TextDecoder().decode(bytes));
    return { ...common, status: "parsed", stage: "complete", code: "PARSED", operationCount: description.operations.length };
  } catch (error) {
    const classified = classifyParseFailure(error);
    return { ...common, ...classified, stage: "parse" };
  }
}

export async function probeExternalOpenApiCorpus(manifest: ExternalOpenApiManifest, loader: ManifestDocumentLoader): Promise<CorpusProbeReport> {
  const startedAt = new Date().toISOString();
  const results: CorpusProbeResult[] = [];
  for (const entry of manifest.entries) results.push(await probeEntry(entry, loader));
  const summary = { parsed: 0, unsupported: 0, invalid: 0, fetch_failed: 0, integrity_failed: 0 } satisfies Record<CorpusProbeStatus, number>;
  for (const result of results) summary[result.status] += 1;
  return { schemaVersion: "a-pidoc.external-openapi-probe-report/v1", corpus: manifest.corpus, startedAt, completedAt: new Date().toISOString(), results, summary };
}
