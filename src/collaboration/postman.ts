import type { ApiRequest, HttpMethod } from "../domain/types.js";
import { PublicError } from "../security/errors.js";
import { redactRequest } from "../security/redaction.js";

interface ImportedPostmanCollection { requests: ApiRequest[]; unsupportedItems: Array<{ name: string; reason: string }> }
type JsonObject = Record<string, unknown>;
const METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PublicError("INVALID_POSTMAN_COLLECTION", `${label} must be an object`);
  return value as JsonObject;
}

function requestUrl(value: unknown): string {
  const raw = typeof value === "string" ? value : object(value, "request.url").raw;
  if (typeof raw !== "string") throw new PublicError("INVALID_POSTMAN_COLLECTION", "request.url.raw must be a string");
  const parsed = new URL(raw); if (!["http:", "https:"].includes(parsed.protocol)) throw new PublicError("INVALID_POSTMAN_COLLECTION", "Only HTTP(S) Postman URLs are supported");
  return parsed.toString();
}

function importRequest(value: unknown): ApiRequest {
  const request = object(value, "item.request"); const method = String(request.method ?? "GET").toUpperCase() as HttpMethod;
  if (!METHODS.has(method)) throw new PublicError("INVALID_POSTMAN_COLLECTION", `Unsupported Postman method: ${method}`);
  const headers: Record<string, string> = {};
  if (request.header !== undefined) {
    if (!Array.isArray(request.header)) throw new PublicError("INVALID_POSTMAN_COLLECTION", "request.header must be an array");
    for (const entry of request.header) { const header = object(entry, "request.header[]"); if (typeof header.key === "string" && typeof header.value === "string" && header.disabled !== true) headers[header.key] = header.value; }
  }
  let body: Record<string, unknown> | null = null;
  if (request.body !== undefined) {
    const postmanBody = object(request.body, "request.body");
    if (postmanBody.mode !== "raw" || typeof postmanBody.raw !== "string") throw new PublicError("UNSUPPORTED_POSTMAN_BODY", "Only raw JSON Postman bodies are supported");
    const parsed = JSON.parse(postmanBody.raw) as unknown; body = object(parsed, "request.body.raw JSON");
  }
  return { method, url: requestUrl(request.url), headers, body };
}

function walkItems(items: unknown[], result: ImportedPostmanCollection): void {
  for (const raw of items) {
    if (result.requests.length + result.unsupportedItems.length >= 100) throw new PublicError("POSTMAN_ITEM_LIMIT", "Postman collection exceeds 100 item limit", 413);
    const item = object(raw, "item"); const name = typeof item.name === "string" ? item.name : "unnamed";
    if (Array.isArray(item.item)) { walkItems(item.item, result); continue; }
    try { result.requests.push(importRequest(item.request)); } catch (error) { result.unsupportedItems.push({ name, reason: error instanceof Error ? error.message : "unsupported item" }); }
  }
}

export function importPostmanCollection(value: unknown): ImportedPostmanCollection {
  const root = object(value, "collection"); if (!Array.isArray(root.item)) throw new PublicError("INVALID_POSTMAN_COLLECTION", "collection.item must be an array");
  const result: ImportedPostmanCollection = { requests: [], unsupportedItems: [] }; walkItems(root.item, result); return result;
}

export function parseApiRequestArray(value: unknown): ApiRequest[] {
  if (!Array.isArray(value) || value.length > 100) throw new PublicError("INVALID_REQUEST_EXPORT", "Request export input must be an array with at most 100 items");
  return value.map((item) => { const request = object(item, "request"); return importRequest({ method: request.method, url: request.url, header: Object.entries(object(request.headers ?? {}, "request.headers")).map(([key, entry]) => ({ key, value: String(entry) })), ...(request.body === null || request.body === undefined ? {} : { body: { mode: "raw", raw: JSON.stringify(object(request.body, "request.body")) } }) }); });
}

export function exportPostmanCollection(requests: ApiRequest[], name = "A-Pidoc verified requests", expectedStatus?: number): JsonObject {
  return {
    info: { name, schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    item: requests.map((input, index) => { const request = redactRequest(input); return { name: `Request ${index + 1}`, request: { method: request.method, header: Object.entries(request.headers).map(([key, value]) => ({ key, value, type: "text" })), url: { raw: request.url }, ...(request.body === null ? {} : { body: { mode: "raw", raw: JSON.stringify(request.body, null, 2), options: { raw: { language: "json" } } } }) }, ...(expectedStatus === undefined ? {} : { event: [{ listen: "test", script: { type: "text/javascript", exec: [`pm.test(\"status is ${expectedStatus}\", function () {`, `  pm.response.to.have.status(${expectedStatus});`, "});"] } }] }) }; })
  };
}
