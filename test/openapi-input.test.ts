import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenApiOperation, validateJsonBody } from "../src/input/openapi-parser.js";

function document(serverUrl = "http://127.0.0.1:3000") {
  return {
    openapi: "3.1.0",
    servers: [{ url: serverUrl }],
    paths: {
      "/orders/{orderId}": {
        parameters: [
          { in: "header", name: "X-Tenant", required: true, schema: { type: "string", example: "demo" } }
        ],
        post: {
          summary: "Update order",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["amount", "active"],
                  properties: {
                    amount: { type: "number", example: 12 },
                    active: { type: "boolean", default: true }
                  }
                }
              }
            }
          },
          responses: { "200": { description: "ok" } }
        }
      }
    }
  };
}

test("parseOpenApiOperation builds a request and spec from an operation", () => {
  const parsed = parseOpenApiOperation(document(), {
    path: "/orders/{orderId}",
    method: "post",
    pathParams: { orderId: "A/B" },
    query: { dryRun: "true" }
  });
  assert.equal(parsed.task.source, "openapi");
  assert.equal(parsed.task.request.method, "POST");
  assert.equal(parsed.task.request.url, "http://127.0.0.1:3000/orders/A%2FB?dryRun=true");
  assert.equal(parsed.task.spec.requiredHeaders["X-Tenant"], "demo");
  assert.equal(parsed.task.spec.requiredHeaders["Content-Type"], "application/json");
});

test("parseOpenApiOperation creates a request body from schema examples and defaults", () => {
  const parsed = parseOpenApiOperation(document(), {
    path: "/orders/{orderId}", method: "POST", pathParams: { orderId: "42" }
  });
  assert.deepEqual(parsed.task.request.body, { amount: 12, active: true });
  assert.deepEqual(parsed.schemaIssues, []);
});

test("validateJsonBody reports missing required properties", () => {
  const issues = validateJsonBody({}, {
    type: "object", required: ["amount"], properties: { amount: { type: "number" } }
  });
  assert.deepEqual(issues, [{ path: "$.amount", message: "required property is missing" }]);
});

test("validateJsonBody reports primitive type mismatches", () => {
  const issues = validateJsonBody({ amount: "12" }, {
    type: "object", required: ["amount"], properties: { amount: { type: "number" } }
  });
  assert.deepEqual(issues, [{ path: "$.amount", message: "expected number, received string" }]);
});

test("parseOpenApiOperation rejects unsupported or incomplete documents", () => {
  assert.throws(
    () => parseOpenApiOperation({ ...document(), openapi: "2.0" }, { path: "/orders/{orderId}", method: "POST" }),
    /OpenAPI 3/
  );
  assert.throws(
    () => parseOpenApiOperation(document(), { path: "/missing", method: "POST" }),
    /must be an object/
  );
  assert.throws(
    () => parseOpenApiOperation(document(), { path: "/orders/{orderId}", method: "POST" }),
    /Missing OpenAPI path parameter/
  );
  assert.throws(
    () => validateJsonBody({}, { $ref: "#/components/schemas/Order" }),
    /dereferenced/
  );
});
