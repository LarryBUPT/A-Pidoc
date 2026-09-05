import { readdir, readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { HttpMethod } from "../domain/types.js";
import { PublicError } from "../security/errors.js";
import type {
  DiscoveredApiCall,
  EnvironmentReference,
  RepositoryFinding,
  RepositoryReport
} from "./types.js";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage"]);
const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface RepositoryScanOptions {
  root: string;
  openApiDocument: unknown;
  maxFiles?: number;
  maxFileBytes?: number;
}

interface OpenApiOperation {
  method: HttpMethod;
  path: string;
  id: string;
  pattern: RegExp;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PublicError("INVALID_OPENAPI", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function pathPattern(path: string): RegExp {
  const escaped = path.split(/(\{[^}]+\})/g).map((part) =>
    /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  ).join("");
  return new RegExp(`^${escaped}/?$`);
}

function openApiOperations(document: unknown): OpenApiOperation[] {
  const root = object(document, "OpenAPI document");
  if (typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) {
    throw new PublicError("INVALID_OPENAPI", "Only OpenAPI 3.x documents are supported");
  }
  const paths = object(root.paths, "OpenAPI paths");
  const operations: OpenApiOperation[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = object(rawItem, `OpenAPI path ${path}`);
    for (const method of HTTP_METHODS) {
      if (item[method.toLowerCase()] === undefined) continue;
      operations.push({ method, path, id: `${method} ${path}`, pattern: pathPattern(path) });
    }
  }
  return operations;
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function relativeFile(root: string, file: string): string {
  return relative(root, file).split(sep).join("/");
}

function parseEnvExample(source: string): Set<string> {
  return new Set(source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return match?.[1] ? [match[1]] : [];
  }));
}

function scanSource(
  root: string,
  file: string,
  source: string,
  operations: OpenApiOperation[],
  declaredEnvironment: Set<string>
): { calls: DiscoveredApiCall[]; environment: EnvironmentReference[]; findings: RepositoryFinding[] } {
  const relativePath = relativeFile(root, file);
  const calls: DiscoveredApiCall[] = [];
  const environment: EnvironmentReference[] = [];
  const findings: RepositoryFinding[] = [];
  const literalStarts = new Set<number>();
  const literalFetch = /\bfetch\s*\(\s*(["'`])(https?:\/\/[^"'`$\r\n]+)\1/g;
  for (const match of source.matchAll(literalFetch)) {
    if (match.index === undefined || !match[2]) continue;
    literalStarts.add(match.index);
    const snippet = source.slice(match.index, match.index + 800);
    const methodMatch = snippet.match(/\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i);
    const method = (methodMatch?.[1]?.toUpperCase() ?? "GET") as HttpMethod;
    const url = new URL(match[2]);
    const operation = operations.find((candidate) => candidate.method === method && candidate.pattern.test(url.pathname));
    calls.push({
      file: relativePath,
      line: lineAt(source, match.index),
      method,
      url: url.toString(),
      openApiOperation: operation?.id ?? null
    });
    if (!operation) {
      findings.push({
        code: "OPENAPI_OPERATION_MISSING",
        severity: "error",
        file: relativePath,
        line: lineAt(source, match.index),
        message: `${method} ${url.pathname} is not declared by the supplied OpenAPI document`
      });
    }
  }

  for (const match of source.matchAll(/\bfetch\s*\(/g)) {
    if (match.index === undefined || literalStarts.has(match.index)) continue;
    findings.push({
      code: "DYNAMIC_FETCH_UNSUPPORTED",
      severity: "info",
      file: relativePath,
      line: lineAt(source, match.index),
      message: "Dynamic fetch target was not interpreted; V2 only accepts literal HTTP(S) URLs"
    });
  }

  const seenEnvironment = new Set<string>();
  for (const pattern of [/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g, /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g]) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (!name || match.index === undefined || seenEnvironment.has(name)) continue;
      seenEnvironment.add(name);
      const declaredInExample = declaredEnvironment.has(name);
      environment.push({ name, declaredInExample, file: relativePath, line: lineAt(source, match.index) });
      if (!declaredInExample) {
        findings.push({
          code: "ENV_NOT_DECLARED",
          severity: "warning",
          file: relativePath,
          line: lineAt(source, match.index),
          message: `${name} is referenced in source but missing from .env.example`
        });
      }
    }
  }
  return { calls, environment, findings };
}

export async function scanRepository(options: RepositoryScanOptions): Promise<RepositoryReport> {
  const root = await realpath(resolve(options.root));
  const maxFiles = options.maxFiles ?? 500;
  const maxFileBytes = options.maxFileBytes ?? 512_000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) {
    throw new PublicError("INVALID_SCAN_LIMIT", "maxFiles must be an integer between 1 and 10000");
  }
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1_024 || maxFileBytes > 5_000_000) {
    throw new PublicError("INVALID_SCAN_LIMIT", "maxFileBytes must be between 1024 and 5000000");
  }

  const operations = openApiOperations(options.openApiDocument);
  let declaredEnvironment = new Set<string>();
  try {
    declaredEnvironment = parseEnvExample(await readFile(resolve(root, ".env.example"), "utf8"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push(path);
      if (files.length > maxFiles) throw new PublicError("SCAN_FILE_LIMIT", `Repository exceeds ${maxFiles} source file limit`, 413);
    }
  }
  await walk(root);

  const apiCalls: DiscoveredApiCall[] = [];
  const environmentReferences: EnvironmentReference[] = [];
  const findings: RepositoryFinding[] = [];
  for (const file of files) {
    const buffer = await readFile(file);
    if (buffer.byteLength > maxFileBytes) {
      findings.push({
        code: "FILE_TOO_LARGE",
        severity: "warning",
        file: relativeFile(root, file),
        line: 1,
        message: `File exceeds ${maxFileBytes} byte scan limit`
      });
      continue;
    }
    const result = scanSource(root, file, buffer.toString("utf8"), operations, declaredEnvironment);
    apiCalls.push(...result.calls);
    environmentReferences.push(...result.environment);
    findings.push(...result.findings);
  }

  return {
    root,
    scannedFiles: files.length,
    apiCalls,
    environmentReferences,
    findings,
    summary: {
      calls: apiCalls.length,
      matchedOperations: apiCalls.filter((call) => call.openApiOperation !== null).length,
      errors: findings.filter((finding) => finding.severity === "error").length,
      warnings: findings.filter((finding) => finding.severity === "warning").length
    }
  };
}
