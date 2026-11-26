// A bounded, offline document reader. Documentation content is data, never code.
export type JsonObject = Record<string, unknown>;
export const unsafeProperty = (name: string): boolean => ["__proto__", "prototype", "constructor"].includes(name);

export function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function decodeHtml(text: string): string {
  return text.replace(/&(?:quot|apos|lt|gt|amp|#\d+|#x[\da-f]+);/gi, (entity) => {
    const known: Record<string, string> = { "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&amp;": "&" };
    if (known[entity]) return known[entity];
    const code = entity.startsWith("&#x") ? Number.parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

export function readApiDocument(input: unknown): JsonObject {
  let document = input;
  if (typeof input === "string") {
    if (Buffer.byteLength(input, "utf8") > 1_000_000) throw new Error("API document exceeds byte limit");
    try { document = JSON.parse(input); } catch {
      const blocks = [
        ...[...input.matchAll(/```(?:json|openapi|swagger)\s*\r?\n([\s\S]*?)```/gi)].map((match) => match[1]!),
        ...[...input.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)].map((match) =>
          decodeHtml(match[1]!.replace(/^\s*<code\b[^>]*>|<\/code>\s*$/gi, "")))
      ];
      const candidates: unknown[] = [];
      for (const block of blocks) {
        try {
          const value = JSON.parse(block);
          if (value?.openapi || value?.swagger) candidates.push(value);
        } catch { /* Ignore unrelated examples, but never guess an API contract. */ }
      }
      if (candidates.length !== 1) throw new Error("Document must contain exactly one JSON OpenAPI/Swagger block");
      document = candidates[0];
    }
  }
  const root = asObject(document, "API document");
  if (Buffer.byteLength(JSON.stringify(root), "utf8") > 1_000_000) throw new Error("API document exceeds byte limit");
  let nodes = 0;
  let expandedBytes = 0;
  function expand(value: unknown, chain: string[] = [], depth = 0): unknown {
    if (++nodes > 20_000 || depth > 32) throw new Error("API document expansion limit exceeded");
    expandedBytes += typeof value === "string" ? Buffer.byteLength(value, "utf8") : 8;
    if (expandedBytes > 2_000_000) throw new Error("API document expansion byte limit exceeded");
    if (Array.isArray(value)) return value.map((item) => expand(item, chain, depth + 1));
    if (!value || typeof value !== "object") return value;
    const obj = value as JsonObject;
    for (const key of Object.keys(obj)) if (unsafeProperty(key)) throw new Error("Unsafe property in API document");
    if ("$ref" in obj) {
      const ref = obj.$ref;
      if (typeof ref !== "string" || !ref.startsWith("#/")) throw new Error("Only local OpenAPI $ref is supported");
      if (chain.includes(ref)) throw new Error("Cyclic OpenAPI $ref is unsupported");
      if (Object.keys(obj).some((key) => !["$ref", "description", "summary"].includes(key))) throw new Error("Assertion siblings of $ref are unsupported");
      let target: unknown = root;
      for (const token of ref.slice(2).split("/")) {
        const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
        if (unsafeProperty(key) || !target || typeof target !== "object" || !Object.hasOwn(target, key)) throw new Error("Unresolved OpenAPI $ref");
        target = (target as JsonObject)[key];
      }
      return expand(target, [...chain, ref], depth + 1);
    }
    return Object.fromEntries(Object.entries(obj).map(([key, val]) => [key, expand(val, chain, depth + 1)]));
  }
  const resolved = expand(root) as JsonObject;
  return resolved.swagger === "2.0" ? convertSwagger(resolved) : resolved;
}

function convertSwagger(root: JsonObject): JsonObject {
  const paths = asObject(root.paths, "Swagger paths");
  const converted: JsonObject = {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = asObject(rawItem, "Swagger path");
    const result: JsonObject = {};
    for (const [method, rawOperation] of Object.entries(item)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      const operation = asObject(rawOperation, "Swagger operation");
      const parameters = [...(Array.isArray(item.parameters) ? item.parameters : []), ...(Array.isArray(operation.parameters) ? operation.parameters : [])].map((value) => asObject(value, "Swagger parameter"));
      if (parameters.some((p) => p.in === "formData")) throw new Error("Swagger formData is unsupported; use JSON body");
      const bodies = parameters.filter((p) => p.in === "body");
      if (bodies.length > 1) throw new Error("Swagger supports one body parameter");
      const consumes = operation.consumes ?? root.consumes ?? ["application/json"];
      if (bodies.length && (!Array.isArray(consumes) || !consumes.includes("application/json"))) throw new Error("Only JSON Swagger request bodies are supported");
      result[method] = {
        ...operation,
        parameters: parameters.filter((p) => p.in !== "body").map((p) => ({ ...p, schema: p.schema ?? Object.fromEntries(Object.entries(p).filter(([key]) => !["name", "in", "required", "description"].includes(key))) })),
        ...(bodies[0] ? { requestBody: { required: bodies[0].required, content: { "application/json": { schema: bodies[0].schema } } } } : {})
      };
    }
    converted[path] = result;
  }
  const schemes = Array.isArray(root.schemes) ? root.schemes : ["https"];
  return { ...root, openapi: "3.0.3", paths: converted,
    servers: typeof root.host === "string" ? [{ url: `${schemes[0]}://${root.host}${root.basePath ?? ""}` }] : [] };
}
