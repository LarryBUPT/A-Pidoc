import { readdir, readFile, realpath } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import type { HttpMethod } from "../domain/types.js";
import { PublicError } from "../security/errors.js";
import type { DiscoveredApiCall, EnvironmentReference, RepositoryFinding, RepositoryReport, UnresolvedApiCall, ValueSource } from "./types.js";

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".py", ".java"]);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".venv", "target", ".a-pidoc"]);
const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface RepositoryScanOptions { root: string; openApiDocument: unknown; maxFiles?: number; maxFileBytes?: number }
interface OpenApiOperation { method: HttpMethod; path: string; id: string; pattern: RegExp }
interface SourceUnit { absolute: string; file: string; source: string }
interface ConstantDefinition { file: string; line: number; expression: string }
interface ImportDefinition { imported: string; target: string }

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError("INVALID_OPENAPI", `${label} must be an object`);
  return value as Record<string, unknown>;
}
function pathPattern(path: string): RegExp { const escaped = path.split(/(\{[^}]+\})/g).map((part) => /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(""); return new RegExp(`^${escaped}/?$`); }
function openApiOperations(document: unknown): OpenApiOperation[] {
  const root = object(document, "OpenAPI document");
  if (typeof root.openapi !== "string" || !root.openapi.startsWith("3.")) throw new PublicError("INVALID_OPENAPI", "Only OpenAPI 3.x documents are supported");
  const paths = object(root.paths, "OpenAPI paths"); const operations: OpenApiOperation[] = [];
  for (const [path, raw] of Object.entries(paths)) { const item = object(raw, `OpenAPI path ${path}`); for (const method of HTTP_METHODS) if (item[method.toLowerCase()] !== undefined) operations.push({ method, path, id: `${method} ${path}`, pattern: pathPattern(path) }); }
  return operations;
}
function lineAt(source: string, index: number): number { return source.slice(0, index).split("\n").length; }
function relativeFile(root: string, file: string): string { return relative(root, file).split(sep).join("/"); }
function method(value: string | undefined, fallback: HttpMethod = "GET"): HttpMethod { const upper = value?.toUpperCase() as HttpMethod; return HTTP_METHODS.has(upper) ? upper : fallback; }
function literal(value: string): string | null { const match = value.trim().match(/^["'`]([^"'`$\r\n]*)["'`]$/); return match?.[1] ?? null; }
function matchOperation(operations: OpenApiOperation[], url: string, verb: HttpMethod): OpenApiOperation | undefined { try { const parsed = new URL(url); return operations.find((candidate) => candidate.method === verb && candidate.pattern.test(parsed.pathname)); } catch { return undefined; } }
function parseEnvExample(source: string): Set<string> { return new Set(source.split(/\r?\n/).flatMap((line) => line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)?.[1] ?? [])); }

function importTarget(unit: SourceUnit, specifier: string, units: Map<string, SourceUnit>): string | null {
  if (!specifier.startsWith(".")) return null;
  const raw = resolve(dirname(unit.absolute), specifier);
  for (const candidate of [raw, `${raw}.ts`, `${raw}.tsx`, `${raw}.js`, `${raw}.jsx`, resolve(raw, "index.ts"), resolve(raw, "index.js")]) {
    const target = units.get(resolve(candidate)); if (target) return target.file;
  }
  return null;
}

function collectDefinitions(units: SourceUnit[]): { constants: Map<string, ConstantDefinition>; imports: Map<string, ImportDefinition> } {
  const unitMap = new Map(units.map((unit) => [resolve(unit.absolute), unit])); const constants = new Map<string, ConstantDefinition>(); const imports = new Map<string, ImportDefinition>();
  for (const unit of units) {
    for (const match of unit.source.matchAll(/\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)/g)) if (match.index !== undefined && match[1] && match[2]) constants.set(`${unit.file}:${match[1]}`, { file: unit.file, line: lineAt(unit.source, match.index), expression: match[2].trim() });
    for (const match of unit.source.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*([^#\r\n]+)/gm)) if (match.index !== undefined && match[1] && match[2]) constants.set(`${unit.file}:${match[1]}`, { file: unit.file, line: lineAt(unit.source, match.index), expression: match[2].trim() });
    for (const match of unit.source.matchAll(/\b(?:static\s+final\s+String|final\s+String)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\r\n]+)/g)) if (match.index !== undefined && match[1] && match[2]) constants.set(`${unit.file}:${match[1]}`, { file: unit.file, line: lineAt(unit.source, match.index), expression: match[2].trim() });
    for (const match of unit.source.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
      const target = match[2] ? importTarget(unit, match[2], unitMap) : null; if (!target || !match[1]) continue;
      for (const entry of match[1].split(",")) { const [imported, local = imported] = entry.trim().split(/\s+as\s+/); if (imported && local) imports.set(`${unit.file}:${local}`, { imported, target }); }
    }
  }
  return { constants, imports };
}

function splitConcat(expression: string): string[] {
  const parts: string[] = []; let quote = ""; let current = "";
  for (const char of expression) { if ((char === "\"" || char === "'" || char === "`") && (!quote || quote === char)) quote = quote ? "" : char; if (char === "+" && !quote) { parts.push(current.trim()); current = ""; } else current += char; }
  if (current.trim()) parts.push(current.trim()); return parts;
}

function resolveExpression(expression: string, file: string, constants: Map<string, ConstantDefinition>, imports: Map<string, ImportDefinition>, seen = new Set<string>()): { value: string | null; source: ValueSource } {
  const trimmed = expression.trim(); const direct = literal(trimmed);
  if (direct !== null) return { value: direct, source: { kind: "literal", expression: trimmed, chain: [] } };
  const env = trimmed.match(/(?:process\.env\.|import\.meta\.env\.|System\.getenv\(\s*["']|os\.environ(?:\.get)?\(\s*["'])([A-Z][A-Z0-9_]*)/);
  if (env?.[1]) return { value: null, source: { kind: "environment", expression: trimmed, environment: env[1], chain: [] } };
  if (/^`[^`]*`$/.test(trimmed)) {
    const chain: ValueSource["chain"] = []; let failed = false;
    const value = trimmed.slice(1, -1).replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_all, name: string) => { const resolved = resolveExpression(name, file, constants, imports, new Set(seen)); chain.push(...resolved.source.chain); if (resolved.value === null) failed = true; return resolved.value ?? ""; });
    return { value: failed ? null : value, source: { kind: failed ? "unresolved" : "constant", expression: trimmed, chain } };
  }
  const concat = splitConcat(trimmed);
  if (concat.length > 1) { const results = concat.map((part) => resolveExpression(part, file, constants, imports, new Set(seen))); const complete = results.every((result) => result.value !== null); return { value: complete ? results.map((result) => result.value).join("") : null, source: { kind: complete ? "constant" : "unresolved", expression: trimmed, chain: results.flatMap((result) => result.source.chain) } }; }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    const imported = imports.get(`${file}:${trimmed}`); const targetFile = imported?.target ?? file; const targetName = imported?.imported ?? trimmed; const key = `${targetFile}:${targetName}`;
    if (seen.has(key)) return { value: null, source: { kind: "unresolved", expression: trimmed, chain: [] } };
    const definition = constants.get(key);
    if (definition) { seen.add(key); const nested = resolveExpression(definition.expression, targetFile, constants, imports, seen); return { value: nested.value, source: { kind: imported ? "import" : "constant", expression: trimmed, chain: [{ file: definition.file, line: definition.line }, ...nested.source.chain] } }; }
  }
  return { value: null, source: { kind: "unresolved", expression: trimmed, chain: [] } };
}

function inlineObject(source: string): Record<string, string> { const result: Record<string, string> = {}; for (const match of source.matchAll(/["']?([A-Za-z][\w-]*)["']?\s*:\s*["']([^"']*)["']/g)) if (match[1] && match[2] !== undefined) result[match[1]] = match[2]; return result; }
function callSnippet(source: string, index: number): string { const end = source.indexOf(");", index); return source.slice(index, end < 0 ? index + 900 : Math.min(end + 2, index + 900)); }
function sourceCall(client: DiscoveredApiCall["client"], unit: SourceUnit, index: number, verb: HttpMethod, snippet: string, operations: OpenApiOperation[], resolved: { value: string; source: ValueSource }): DiscoveredApiCall {
  const operation = matchOperation(operations, resolved.value, verb); const headersMatch = snippet.match(/headers\s*:\s*\{([^}]*)\}/s); const bodyMatch = snippet.match(/body\s*:\s*JSON\.stringify\(\s*\{([^}]*)\}\s*\)/s);
  return { client, file: unit.file, line: lineAt(unit.source, index), method: verb, url: resolved.value, openApiOperation: operation?.id ?? null, headers: headersMatch?.[1] ? inlineObject(headersMatch[1]) : {}, body: bodyMatch?.[1] ? inlineObject(bodyMatch[1]) : null, sources: { url: resolved.source, method: { kind: "literal", expression: verb, chain: [] }, headers: { kind: headersMatch ? "literal" : "unresolved", expression: headersMatch?.[0] ?? "", chain: [] }, body: { kind: bodyMatch ? "literal" : "unresolved", expression: bodyMatch?.[0] ?? "", chain: [] } }, sourceText: snippet.slice(0, 400) };
}

function scanSource(unit: SourceUnit, operations: OpenApiOperation[], declared: Set<string>, constants: Map<string, ConstantDefinition>, imports: Map<string, ImportDefinition>): { calls: DiscoveredApiCall[]; unresolved: UnresolvedApiCall[]; environment: EnvironmentReference[]; findings: RepositoryFinding[] } {
  const calls: DiscoveredApiCall[] = []; const unresolved: UnresolvedApiCall[] = []; const environment: EnvironmentReference[] = []; const findings: RepositoryFinding[] = []; const candidates: Array<{ client: DiscoveredApiCall["client"]; index: number; expression: string; verb: HttpMethod; snippet: string }> = [];
  for (const match of unit.source.matchAll(/\bfetch\s*\(\s*([^,\r\n)]+(?:\([^)]*\))?)/g)) if (match.index !== undefined && match[1]) { const snippet = callSnippet(unit.source, match.index); candidates.push({ client: "fetch", index: match.index, expression: match[1], verb: method(snippet.match(/\bmethod\s*:\s*["'](GET|POST|PUT|PATCH|DELETE)["']/i)?.[1]), snippet }); }
  for (const match of unit.source.matchAll(/\baxios\.(get|post|put|patch|delete)\s*\(\s*([^,\r\n)]+(?:\([^)]*\))?)/gi)) if (match.index !== undefined && match[1] && match[2]) candidates.push({ client: "axios", index: match.index, expression: match[2], verb: method(match[1]), snippet: callSnippet(unit.source, match.index) });
  for (const match of unit.source.matchAll(/\brequests\.(get|post|put|patch|delete)\s*\(\s*([^,\r\n)]+(?:\([^)]*\))?)/gi)) if (match.index !== undefined && match[1] && match[2]) candidates.push({ client: "requests", index: match.index, expression: match[2], verb: method(match[1]), snippet: callSnippet(unit.source, match.index) });
  for (const match of unit.source.matchAll(/Request\.Builder\(\)[\s\S]{0,800}?\.url\(\s*([^\r\n)]+(?:\([^)]*\))?)[\s\S]{0,300}?\.build\(\)/g)) if (match.index !== undefined && match[1]) { const snippet = unit.source.slice(match.index, match.index + 1000); candidates.push({ client: "okhttp", index: match.index, expression: match[1], verb: method(snippet.match(/\.(get|post|put|patch|delete)\s*\(/i)?.[1]), snippet }); }
  for (const candidate of candidates) {
    const result = resolveExpression(candidate.expression, unit.file, constants, imports);
    if (result.value === null || !/^https?:\/\//.test(result.value)) { unresolved.push({ client: candidate.client, method: candidate.verb, expression: candidate.expression.trim(), file: unit.file, line: lineAt(unit.source, candidate.index), source: result.source }); const message = `${candidate.client} URL expression was not resolved by the documented V2 data-flow subset`; findings.push({ code: "DYNAMIC_URL_UNSUPPORTED", severity: "info", file: unit.file, line: lineAt(unit.source, candidate.index), message }); if (candidate.client === "fetch") findings.push({ code: "DYNAMIC_FETCH_UNSUPPORTED", severity: "info", file: unit.file, line: lineAt(unit.source, candidate.index), message }); continue; }
    const call = sourceCall(candidate.client, unit, candidate.index, candidate.verb, candidate.snippet, operations, { value: result.value, source: result.source }); calls.push(call); if (!call.openApiOperation) findings.push({ code: "OPENAPI_OPERATION_MISSING", severity: "error", file: call.file, line: call.line, message: `${call.method} ${call.url} is not declared by the supplied OpenAPI document` });
  }
  const seenEnvironment = new Set<string>();
  for (const pattern of [/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g, /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g, /\bos\.environ(?:\.get)?\(\s*["']([A-Z][A-Z0-9_]*)["']/g, /\bSystem\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g]) for (const match of unit.source.matchAll(pattern)) { const name = match[1]; if (!name || match.index === undefined || seenEnvironment.has(name)) continue; seenEnvironment.add(name); const declaredInExample = declared.has(name); environment.push({ name, declaredInExample, file: unit.file, line: lineAt(unit.source, match.index) }); if (!declaredInExample) findings.push({ code: "ENV_NOT_DECLARED", severity: "warning", file: unit.file, line: lineAt(unit.source, match.index), message: `${name} is referenced in source but missing from .env.example` }); }
  return { calls, unresolved, environment, findings };
}

export async function scanRepository(options: RepositoryScanOptions): Promise<RepositoryReport> {
  const root = await realpath(resolve(options.root)); const maxFiles = options.maxFiles ?? 500; const maxFileBytes = options.maxFileBytes ?? 512_000;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 10_000) throw new PublicError("INVALID_SCAN_LIMIT", "maxFiles must be between 1 and 10000");
  if (!Number.isInteger(maxFileBytes) || maxFileBytes < 1_024 || maxFileBytes > 5_000_000) throw new PublicError("INVALID_SCAN_LIMIT", "maxFileBytes must be between 1024 and 5000000");
  const operations = openApiOperations(options.openApiDocument); let declared = new Set<string>(); try { declared = parseEnvExample(await readFile(resolve(root, ".env.example"), "utf8")); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const units: SourceUnit[] = []; const findings: RepositoryFinding[] = [];
  async function walk(directory: string): Promise<void> { for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.isSymbolicLink()) continue; const path = resolve(directory, entry.name); if (entry.isDirectory()) { if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(path); continue; } if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue; if (units.length + 1 > maxFiles) throw new PublicError("SCAN_FILE_LIMIT", `Repository exceeds ${maxFiles} source file limit`, 413); const buffer = await readFile(path); const file = relativeFile(root, path); if (buffer.byteLength > maxFileBytes) { findings.push({ code: "FILE_TOO_LARGE", severity: "warning", file, line: 1, message: `File exceeds ${maxFileBytes} byte scan limit` }); continue; } units.push({ absolute: path, file, source: buffer.toString("utf8") }); } }
  await walk(root); const { constants, imports } = collectDefinitions(units); const apiCalls: DiscoveredApiCall[] = []; const unresolvedCalls: UnresolvedApiCall[] = []; const environmentReferences: EnvironmentReference[] = [];
  for (const unit of units) { const result = scanSource(unit, operations, declared, constants, imports); apiCalls.push(...result.calls); unresolvedCalls.push(...result.unresolved); environmentReferences.push(...result.environment); findings.push(...result.findings); }
  return { root, scannedFiles: units.length, apiCalls, unresolvedCalls, environmentReferences, findings, summary: { calls: apiCalls.length, matchedOperations: apiCalls.filter((call) => call.openApiOperation !== null).length, errors: findings.filter((finding) => finding.severity === "error").length, warnings: findings.filter((finding) => finding.severity === "warning").length } };
}
