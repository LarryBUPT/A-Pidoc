import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { createRealApp } from "../src/app.js";
import { parseCurlTask } from "../src/input/debug-input.js";
import { createApiServer } from "../src/server.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  return address.port;
}

function jsonSpec() {
  return {
    method: "POST" as const,
    requiredHeaders: { "Content-Type": "application/json" },
    requiredBody: { amount: "number" as const }
  };
}

test("curl input runs through the real diagnose, fix, retry, review, and trace loop", async (context) => {
  const target = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.headers["content-type"] !== "application/json") {
      response.statusCode = 415;
      response.end(JSON.stringify({ error: "unsupported media type: expected application/json" }));
      return;
    }
    response.end(JSON.stringify({ ok: true, token: "must-not-leak" }));
  });
  context.after(() => target.close());
  const port = await listen(target);
  const task = parseCurlTask({
    kind: "curl",
    command: `curl -X POST 'http://127.0.0.1:${port}/orders?api_key=query-private' -H 'authorization: Bearer header-private' -H 'content-type: text/plain' -d '{"amount":12}'`,
    spec: jsonSpec()
  });
  const report = await createRealApp({ allowedHosts: ["127.0.0.1"], allowedPorts: [port] }).run(task);

  assert.equal(report.status, "resolved");
  assert.equal(report.rootCause, "CONTENT_TYPE_MISMATCH");
  assert.equal(report.attempts.length, 2);
  assert.equal(report.evaluation.passed, true);
  assert.equal(report.originalRequest.headers.authorization, "[REDACTED]");
  assert.match(report.originalRequest.url, /api_key=%5BREDACTED%5D/);
  assert.equal(report.attempts[0]?.request.headers.authorization, "[REDACTED]");
  assert.equal(report.attempts[1]?.request.headers["Content-Type"], "application/json");
  assert.equal(report.attempts[1]?.request.headers["content-type"], undefined);
  assert.equal(report.attempts[1]?.result.body.token, "[REDACTED]");
  assert.ok(report.trace.some((event) => event.metadata?.inputSource === "curl"));
  assert.ok(report.trace.some((event) =>
    event.stage === "http_tool" &&
    event.status === "succeeded" &&
    typeof event.durationMs === "number" &&
    event.metadata?.redacted === true
  ));
  assert.ok(JSON.stringify(report).includes("query-private") === false);
  assert.ok(JSON.stringify(report).includes("header-private") === false);
});

test("real diagnostics reject credentials embedded in a URL", async () => {
  const task = parseCurlTask({
    kind: "curl",
    command: "curl http://user:password@127.0.0.1:3001/health",
    spec: { method: "GET", requiredHeaders: {}, requiredBody: {} }
  });
  const report = await createRealApp({ allowedHosts: ["127.0.0.1"], allowedPorts: [3001] }).run(task);
  assert.equal(report.status, "blocked");
  assert.equal(report.attempts.length, 0);
  assert.match(report.summary, /credentials embedded/);
  assert.ok(JSON.stringify(report).includes("password") === false);
});

test("HTTP API accepts curl input while the server controls the host allowlist", async (context) => {
  const target = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  context.after(() => target.close());
  const targetPort = await listen(target);
  const api = createApiServer({ allowedHosts: ["127.0.0.1"], allowedPorts: [targetPort] });
  context.after(() => api.close());
  const apiPort = await listen(api);

  const response = await fetch(`http://127.0.0.1:${apiPort}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "curl",
      command: `curl http://127.0.0.1:${targetPort}/health`,
      spec: { method: "GET", requiredHeaders: {}, requiredBody: {} }
    })
  });
  const report = await response.json() as { status: string; inputSource: string; evaluation: { passed: boolean } };
  assert.equal(response.status, 200);
  assert.equal(report.status, "resolved");
  assert.equal(report.inputSource, "curl");
  assert.equal(report.evaluation.passed, true);
});

test("HTTP API validates OpenAPI request bodies before network execution", async (context) => {
  const api = createApiServer({ allowedHosts: ["127.0.0.1"], allowedPorts: [1] });
  context.after(() => api.close());
  const apiPort = await listen(api);
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "openapi",
      document: {
        openapi: "3.0.3",
        servers: [{ url: "http://127.0.0.1:1" }],
        paths: {
          "/orders": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["amount"],
                      properties: { amount: { type: "number" } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      operation: { path: "/orders", method: "POST", body: { amount: "wrong" } }
    })
  });
  const body = await response.json() as { error: string; issues: unknown[] };
  assert.equal(response.status, 422);
  assert.match(body.error, /OpenAPI schema/);
  assert.equal(body.issues.length, 1);
});

test("HTTP API executes a valid OpenAPI operation", async (context) => {
  const target = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });
  context.after(() => target.close());
  const targetPort = await listen(target);
  const api = createApiServer({ allowedHosts: ["127.0.0.1"], allowedPorts: [targetPort] });
  context.after(() => api.close());
  const apiPort = await listen(api);
  const response = await fetch(`http://127.0.0.1:${apiPort}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "openapi",
      document: {
        openapi: "3.0.3",
        servers: [{ url: `http://127.0.0.1:${targetPort}` }],
        paths: { "/health": { get: { responses: { "200": { description: "ok" } } } } }
      },
      operation: { path: "/health", method: "GET" }
    })
  });
  const report = await response.json() as { status: string; inputSource: string; evaluation: { passed: boolean } };
  assert.equal(response.status, 200);
  assert.equal(report.status, "resolved");
  assert.equal(report.inputSource, "openapi");
  assert.equal(report.evaluation.passed, true);
});
