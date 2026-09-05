import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { parseCurl } from "../src/input/curl-parser.js";
import { RealHttpTool } from "../src/tools/real-http-tool.js";
import { getCase } from "../src/fixtures/cases.js";

test("parseCurl parses method, URL, headers, query, and JSON body", () => {
  const request = parseCurl(
    `curl -X PATCH 'https://api.example.test/orders?id=42' -H 'Authorization: Bearer demo' -H 'Content-Type: application/json' --data-raw '{"amount":12}'`
  );
  assert.equal(request.method, "PATCH");
  assert.equal(request.url, "https://api.example.test/orders?id=42");
  assert.equal(request.headers.Authorization, "Bearer demo");
  assert.deepEqual(request.body, { amount: 12 });
});

test("parseCurl infers GET without data and POST with data", () => {
  assert.equal(parseCurl("curl https://example.test/health").method, "GET");
  assert.equal(parseCurl(`curl https://example.test/orders -d '{"amount":1}'`).method, "POST");
});

test("parseCurl rejects malformed and unsafe input", () => {
  assert.throws(() => parseCurl("wget https://example.test"), /start with curl/);
  assert.throws(() => parseCurl("curl ftp://example.test/file"), /does not contain an HTTP/);
  assert.throws(() => parseCurl("curl https://example.test -d nope"), /Only JSON/);
  assert.throws(() => parseCurl("curl --compressed https://example.test"), /Unsupported curl option/);
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  return address.port;
}

test("RealHttpTool executes local requests and redacts sensitive response data", async (context) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.setHeader("set-cookie", "session=private");
    response.end(JSON.stringify({ ok: true, token: "private", nested: { password: "private" } }));
  });
  context.after(() => server.close());
  const port = await listen(server);
  const tool = new RealHttpTool({ allowedHosts: ["127.0.0.1"] });
  const request = parseCurl(`curl http://127.0.0.1:${port}/health`);
  const result = await tool.execute(getCase("auth-header"), request);

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, token: "[REDACTED]", nested: { password: "[REDACTED]" } });
  assert.equal(result.headers["set-cookie"], "[REDACTED]");
});

test("RealHttpTool blocks hosts, times out, and limits response size", async (context) => {
  const server = createServer((request, response) => {
    if (request.url === "/slow") setTimeout(() => response.end("late"), 100);
    else response.end("response-too-large");
  });
  context.after(() => server.close());
  const port = await listen(server);
  const fixture = getCase("auth-header");

  await assert.rejects(
    new RealHttpTool().execute(fixture, parseCurl("curl https://example.com")),
    /Blocked host/
  );
  await assert.rejects(
    new RealHttpTool({ timeoutMs: 10 }).execute(fixture, parseCurl(`curl http://127.0.0.1:${port}/slow`)),
    /aborted|timeout/i
  );
  await assert.rejects(
    new RealHttpTool({ maxResponseBytes: 5 }).execute(fixture, parseCurl(`curl http://127.0.0.1:${port}/large`)),
    /exceeds 5 byte limit/
  );
});
