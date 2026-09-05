import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { parseCurl } from "../src/input/curl-parser.js";
import { RealHttpTool } from "../src/tools/real-http-tool.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  return address.port;
}

test("parseCurl parses method, URL, headers, query, and JSON body", () => {
  const request = parseCurl(
    `curl -X PATCH 'https://api.example.test/orders?id=42' -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' --data-raw '{"amount":12}'`
  );
  assert.equal(request.method, "PATCH");
  assert.equal(request.url, "https://api.example.test/orders?id=42");
  assert.equal(request.headers.Authorization, "Bearer demo");
  assert.deepEqual(request.body, { amount: 12 });
});

test("parseCurl infers GET when no body is present", () => {
  assert.equal(parseCurl("curl https://example.test/health").method, "GET");
});

test("parseCurl infers POST when a body is present", () => {
  assert.equal(parseCurl(`curl https://example.test/orders -d '{"amount":1}'`).method, "POST");
});

test("parseCurl rejects commands that are not curl", () => {
  assert.throws(() => parseCurl("wget https://example.test"), /start with curl/);
});

test("parseCurl rejects unsupported protocols, options, bodies, and broken quotes", () => {
  assert.throws(() => parseCurl("curl ftp://example.test/file"), /does not contain an HTTP/);
  assert.throws(() => parseCurl("curl --compressed https://example.test"), /Unsupported curl option/);
  assert.throws(() => parseCurl("curl https://example.test -d nope"), /Only JSON/);
  assert.throws(() => parseCurl(`curl 'https://example.test`), /unterminated/);
});

test("RealHttpTool executes local requests and redacts sensitive response data", async (context) => {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("set-cookie", "session=private");
    response.end(JSON.stringify({ ok: true, token: "private", nested: { password: "private" } }));
  });
  context.after(() => server.close());
  const port = await listen(server);
  const result = await new RealHttpTool({ allowedHosts: ["127.0.0.1"], allowedPorts: [port] })
    .execute(parseCurl(`curl http://127.0.0.1:${port}/health`));

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, token: "[REDACTED]", nested: { password: "[REDACTED]" } });
  assert.equal(result.headers["set-cookie"], "[REDACTED]");
});

test("RealHttpTool preserves non-JSON responses as data", async (context) => {
  const server = createServer((_request, response) => response.end("plain response"));
  context.after(() => server.close());
  const port = await listen(server);
  const result = await new RealHttpTool({ allowedHosts: ["127.0.0.1"], allowedPorts: [port] })
    .execute(parseCurl(`curl http://127.0.0.1:${port}/plain`));
  assert.deepEqual(result.body, { data: "plain response" });
});

test("RealHttpTool blocks hosts outside its allowlist", async () => {
  await assert.rejects(new RealHttpTool().execute(parseCurl("curl https://example.com")), /Blocked host/);
});

test("RealHttpTool times out slow requests", async (context) => {
  const server = createServer((_request, response) => setTimeout(() => response.end("late"), 100));
  context.after(() => server.close());
  const port = await listen(server);
  await assert.rejects(
    new RealHttpTool({ timeoutMs: 10, allowedPorts: [port] }).execute(parseCurl(`curl http://127.0.0.1:${port}/slow`)),
    /aborted|timeout/i
  );
});

test("RealHttpTool rejects oversized responses", async (context) => {
  const server = createServer((_request, response) => response.end("response-too-large"));
  context.after(() => server.close());
  const port = await listen(server);
  await assert.rejects(
    new RealHttpTool({ maxResponseBytes: 5, allowedPorts: [port] }).execute(parseCurl(`curl http://127.0.0.1:${port}/large`)),
    /exceeds 5 byte limit/
  );
});
