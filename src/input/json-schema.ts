import { asObject, unsafeProperty, type JsonObject } from "./api-document.js";
import { isSensitiveKey } from "../security/redaction.js";

export interface SchemaIssue { path: string; message: string }
const annotations = ["title", "description", "example", "examples", "default", "deprecated", "readOnly", "writeOnly", "xml", "externalDocs", "$schema", "$id"];
const assertions = ["type", "properties", "required", "additionalProperties", "items", "enum", "const", "nullable", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"];
const types = ["object", "array", "string", "integer", "number", "boolean", "null"];

export function assertSupportedSchema(schema: unknown, depth = 0): asserts schema is JsonObject {
  if (depth > 24) throw new Error("Schema depth exceeds limit");
  const obj = asObject(schema, "request body schema");
  if ("$ref" in obj) throw new Error("Schema must be dereferenced before validation");
  for (const key of Object.keys(obj)) {
    if (!annotations.includes(key) && !assertions.includes(key) && !key.startsWith("x-")) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (obj.type !== undefined && (typeof obj.type !== "string" || !types.includes(obj.type))) throw new Error("Unsupported schema type");
  if (obj.enum !== undefined && (!Array.isArray(obj.enum) || obj.enum.length === 0)) throw new Error("Schema enum must be a nonempty array");
  if (obj.required !== undefined && (!Array.isArray(obj.required) || obj.required.some((name) => typeof name !== "string" || unsafeProperty(name)))) throw new Error("Schema required must contain safe property names");
  for (const key of ["nullable", "readOnly", "writeOnly"]) if (obj[key] !== undefined && typeof obj[key] !== "boolean") throw new Error(`Schema ${key} must be boolean`);
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) {
    const value = obj[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || ((key.includes("Length") || key.includes("Items")) && (!Number.isInteger(value) || value < 0)))) throw new Error(`Invalid schema ${key}`);
  }
  if (obj.properties !== undefined) for (const [name, child] of Object.entries(asObject(obj.properties, "schema properties"))) {
    if (unsafeProperty(name)) throw new Error("Unsafe schema property");
    assertSupportedSchema(child, depth + 1);
  }
  if (obj.items !== undefined) assertSupportedSchema(obj.items, depth + 1);
  if (obj.additionalProperties !== undefined && typeof obj.additionalProperties !== "boolean") assertSupportedSchema(obj.additionalProperties, depth + 1);
}

export function validateSchema(value: unknown, schema: unknown, path = "$", depth = 0): SchemaIssue[] {
  if (depth === 0) assertSupportedSchema(schema);
  const obj = schema as JsonObject;
  const issues: SchemaIssue[] = [];
  const fail = (message: string) => issues.push({ path, message });
  if (depth > 24) { fail("value depth exceeds limit"); return issues; }
  if (value === null && obj.nullable === true) return [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (obj.type && !(obj.type === "integer" ? typeof value === "number" && Number.isInteger(value) : obj.type === actual)) {
    fail(`expected ${obj.type}, received ${actual}`); return issues;
  }
  if (typeof value === "number" && !Number.isFinite(value)) fail("number must be finite");
  if (Array.isArray(obj.enum) && !obj.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) fail("value is not in enum");
  if ("const" in obj && JSON.stringify(obj.const) !== JSON.stringify(value)) fail("value does not match const");
  if (typeof value === "number") {
    if (typeof obj.minimum === "number" && value < obj.minimum) fail(`minimum is ${obj.minimum}`);
    if (typeof obj.maximum === "number" && value > obj.maximum) fail(`maximum is ${obj.maximum}`);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof obj.minLength === "number" && length < obj.minLength) fail(`minLength is ${obj.minLength}`);
    if (typeof obj.maxLength === "number" && length > obj.maxLength) fail(`maxLength is ${obj.maxLength}`);
  }
  if (Array.isArray(value)) {
    if (typeof obj.minItems === "number" && value.length < obj.minItems) fail(`minItems is ${obj.minItems}`);
    if (typeof obj.maxItems === "number" && value.length > obj.maxItems) fail(`maxItems is ${obj.maxItems}`);
    if (obj.items) value.forEach((item, index) => issues.push(...validateSchema(item, obj.items, `${path}[${index}]`, depth + 1)));
  } else if (value && typeof value === "object") {
    const body = value as JsonObject;
    const properties = (obj.properties ?? {}) as JsonObject;
    for (const name of (obj.required ?? []) as string[]) if (!Object.hasOwn(body, name)) issues.push({ path: `${path}.${name}`, message: "required property is missing" });
    for (const [name, item] of Object.entries(body)) {
      if (unsafeProperty(name)) { issues.push({ path: `${path}.${name}`, message: "unsafe property" }); continue; }
      if (Object.hasOwn(properties, name)) issues.push(...validateSchema(item, properties[name], `${path}.${name}`, depth + 1));
      else if (obj.additionalProperties === false) issues.push({ path: `${path}.${name}`, message: "additional property is forbidden" });
      else if (obj.additionalProperties && typeof obj.additionalProperties === "object") issues.push(...validateSchema(item, obj.additionalProperties, `${path}.${name}`, depth + 1));
    }
  }
  return issues;
}

// Fill only documented values. Absence of a business value remains a validation issue.
export function fillDocumentedDefaults(value: unknown, schema: JsonObject, depth = 0): unknown {
  if (depth > 24) throw new Error("Default expansion depth exceeds limit");
  if (value === undefined) {
    if ("example" in schema) return structuredClone(schema.example);
    if ("default" in schema) return structuredClone(schema.default);
    if (schema.type !== "object") return undefined;
    value = {};
  }
  if (Array.isArray(value) && schema.items) return value.map((item) => fillDocumentedDefaults(item, schema.items as JsonObject, depth + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = structuredClone(value) as JsonObject;
  const properties = (schema.properties ?? {}) as JsonObject;
  for (const [name, child] of Object.entries(properties)) {
    if (unsafeProperty(name) || isSensitiveKey(name)) continue;
    if (!Object.hasOwn(result, name) && !(schema.required as string[] | undefined)?.includes(name)) continue;
    const filled = fillDocumentedDefaults(result[name], child as JsonObject, depth + 1);
    if (filled !== undefined) result[name] = filled;
  }
  return result;
}
