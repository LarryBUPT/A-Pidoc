import assert from "node:assert/strict";
import test from "node:test";
import { readApiDocument } from "../src/input/api-document.js";
import { parseOpenApiOperation, validateJsonBody } from "../src/input/openapi-parser.js";
import { parseRealDebugInput } from "../src/input/debug-input.js";
import { fillDocumentedDefaults, validateSchema } from "../src/input/json-schema.js";

const schema = {
  type: "object", required: ["customer", "items"], additionalProperties: false,
  properties: {
    customer: { type: "object", required: ["tier"], properties: { tier: { type: "string", enum: ["basic", "pro"], default: "basic" } } },
    items: { type: "array", minItems: 1, items: { type: "object", required: ["quantity"], properties: { quantity: { type: "integer", minimum: 1 } } } }
  }
};
const doc = {
  openapi: "3.1.0", servers: [{ url: "http://127.0.0.1:3000" }],
  components: { schemas: { Order: schema } },
  paths: { "/orders": { post: { requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } } } } }
};

test("document readers accept JSON, Markdown and HTML without executing document content", () => {
  const json = JSON.stringify(doc);
  for (const input of [json, `# Orders\n\n\`\`\`json\n${json}\n\`\`\``, `<script>throw Error()</script><pre><code>${json.replaceAll('"', "&quot;")}</code></pre>`]) {
    const parsed = parseRealDebugInput({ kind: "openapi", document: input, operation: { path: "/orders", method: "POST", body: { customer: { tier: "pro" }, items: [{ quantity: 1 }] } } });
    assert.deepEqual(parsed.schemaIssues, []);
    assert.equal(parsed.task.spec.bodySchema?.type, "object");
  }
});

test("document readers reject ambiguity, external/cyclic/missing references and expansion attacks", () => {
  assert.throws(() => readApiDocument(`\`\`\`json\n${JSON.stringify(doc)}\n\`\`\`\n\`\`\`json\n${JSON.stringify(doc)}\n\`\`\``), /exactly one/);
  assert.throws(() => readApiDocument({ ...doc, evil: { $ref: "https://attacker.test/spec" } }), /Only local/);
  assert.throws(() => readApiDocument({ a: { $ref: "#/a" } }), /Cyclic/);
  assert.throws(() => readApiDocument({ a: { $ref: "#/missing" } }), /Unresolved/);
  assert.throws(() => readApiDocument('{"__proto__":{}}'), /Unsafe/);
  assert.throws(() => readApiDocument(" ".repeat(1_000_001)), /byte limit/);
  assert.throws(() => readApiDocument({ a: { $ref: "#/b", minimum: 10 }, b: { type: "number" } }), /siblings/);
});

test("Swagger 2 body and shared parameter normalize to the same request contract", () => {
  const swagger = { swagger: "2.0", host: "127.0.0.1:3000", schemes: ["http"], basePath: "/v1", definitions: { Body: { type: "object", required: ["n"], properties: { n: { type: "integer", default: 2 } } } }, paths: { "/orders": { parameters: [{ in: "header", name: "X-Tenant", required: true, type: "string", default: "demo" }], post: { parameters: [{ in: "body", name: "body", required: true, schema: { $ref: "#/definitions/Body" } }] } } } };
  const parsed = parseOpenApiOperation(swagger, { path: "/orders", method: "POST" });
  assert.equal(parsed.task.request.url, "http://127.0.0.1:3000/v1/orders");
  assert.equal(parsed.task.spec.requiredHeaders["X-Tenant"], "demo");
  assert.deepEqual(parsed.task.request.body, { n: 2 });
  assert.deepEqual(parsed.schemaIssues, []);
});

test("recursive validation reports enum, integer, array, missing and additional fields at exact paths", () => {
  const issues = validateJsonBody({ customer: { tier: "enterprise" }, items: [{ quantity: 1.5 }, {}], extra: true }, schema);
  assert.deepEqual(issues.map((i) => i.path), ["$.customer.tier", "$.items[0].quantity", "$.items[1].quantity", "$.extra"]);
  assert.match(validateJsonBody({ customer: { tier: "pro" }, items: [] }, schema)[0]!.message, /minItems/);
  assert.match(validateSchema(-1, { type: "number", minimum: 0 })[0]!.message, /minimum/);
  assert.match(validateSchema("abc", { type: "string", maxLength: 2 })[0]!.message, /maxLength/);
  assert.deepEqual(validateSchema(null, { type: "string", nullable: true }), []);
});

test("defaults fill documented required fields only and preserve missing business values", () => {
  const contract = { type: "object", required: ["amount", "active", "token", "customer"], properties: { amount: { type: "number" }, active: { type: "boolean", default: false }, token: { type: "string", default: "never-inject" }, customer: schema.properties.customer } };
  assert.deepEqual(fillDocumentedDefaults(undefined, contract), { active: false, customer: { tier: "basic" } });
  const unresolved = parseOpenApiOperation({ ...doc, paths: { "/orders": { post: { requestBody: { required: true, content: { "application/json": { schema: contract } } } } } } }, { path: "/orders", method: "POST" });
  assert.deepEqual(unresolved.schemaIssues.map((i) => i.path), ["$.amount", "$.token"]);
});

test("unsupported or malformed schema assertions fail explicitly, even with empty bodies", () => {
  for (const invalid of [{ oneOf: [] }, { type: "string", pattern: "(a+)+" }, { type: "object", properties: { x: { format: "email" } } }, { type: "array", items: false }, { minItems: -1 }, { required: [3] }, { enum: [] }]) {
    assert.throws(() => validateSchema({}, invalid));
  }
});
