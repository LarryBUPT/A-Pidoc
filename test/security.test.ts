import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { PiReasoner } from "../src/agent/pi-reasoner.js";
import { DebugOrchestrator } from "../src/core/orchestrator.js";
import type { HttpTool, Reasoner } from "../src/domain/types.js";
import { getCase } from "../src/fixtures/cases.js";
import { redactRequest, redactText, redactValue } from "../src/security/redaction.js";
import { RequestPolicy } from "../src/security/request-policy.js";
import { createApiServer } from "../src/server.js";
import { FixtureHttpTool } from "../src/tools/fixture-http-tool.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind");
  return address.port;
}

function piInput(): Parameters<Reasoner["diagnose"]>[0] {
  return {
    request: { method: "POST" as const, url: "https://fixture.local/orders", headers: {}, body: {} },
    spec: { method: "POST" as const, requiredHeaders: { "Content-Type": "application/json" }, requiredBody: {} },
    result: { status: 415, body: { error: "unsupported media type" }, headers: {}, durationMs: 1 },
    rules: []
  };
}

test("value redaction removes secrets and basic PII hidden in ordinary text fields", () => {
  const value = redactValue({
    message: "Bearer abcdefghijklmnop sk-supersecret123 user@example.com 13800138000",
    detail: "api_key=ordinary-field-secret"
  });
  const serialized = JSON.stringify(value);
  for (const secret of ["abcdefghijklmnop", "supersecret123", "user@example.com", "13800138000", "ordinary-field-secret"]) {
    assert.doesNotMatch(serialized, new RegExp(secret));
  }
  assert.equal(redactText("normal diagnostic text"), "normal diagnostic text");
  assert.doesNotMatch(
    redactRequest({ method: "GET", url: "https://example.test/?note=sk-secret-hidden-value", headers: {}, body: null }).url,
    /secret-hidden-value/
  );
});

test("provider errors are replaced before reports and Trace are exposed", async (context) => {
  const provider = registerFauxProvider({ provider: "security-provider", models: [{ id: "safe-model", input: ["text"] }] });
  context.after(() => provider.unregister());
  provider.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 key suffix leak-TAIL" })]);
  const task = getCase("content-type");
  const report = await new DebugOrchestrator(
    new FixtureHttpTool(task),
    new PiReasoner({ model: provider.getModel() }),
    undefined,
    new RequestPolicy({ allowedHosts: ["fixture.local"], allowedPorts: [443] })
  ).run(task);
  const output = JSON.stringify(report);
  assert.match(output, /PI_PROVIDER_ERROR/);
  assert.doesNotMatch(output, /leak-TAIL|401 key suffix/);
});

test("Pi rejects oversized prompts before making a provider call", async (context) => {
  const provider = registerFauxProvider({ provider: "prompt-budget-provider", models: [{ id: "budget-model", input: ["text"] }] });
  context.after(() => provider.unregister());
  provider.setResponses([fauxAssistantMessage("unused")]);
  const reasoner = new PiReasoner({ model: provider.getModel(), maxPromptBytes: 1024 });
  const input = piInput();
  input.result.body = { message: "x".repeat(2_000) };
  await assert.rejects(() => reasoner.diagnose(input), /prompt exceeds configured byte limit/);
  assert.equal(provider.state.callCount, 0);
});

test("request policy blocks unlisted ports and DNS results in private networks", async () => {
  const policy = new RequestPolicy({
    allowedHosts: ["service.example"],
    allowedPorts: [443],
    resolveHost: async () => ["169.254.169.254"]
  });
  assert.throws(
    () => policy.assertAllowed({ method: "GET", url: "https://service.example:8443", headers: {}, body: null }),
    /Blocked port/
  );
  await assert.rejects(
    () => policy.assertResolvedAddressAllowed({ method: "GET", url: "https://service.example", headers: {}, body: null }),
    /private network address/
  );
});

test("HTTP API enforces Origin, Bearer authentication, and per-client rate limits", async (context) => {
  const api = createApiServer({ apiToken: "test-token-123456", rateLimit: 1 });
  context.after(() => api.close());
  const port = await listen(api);
  const url = `http://127.0.0.1:${port}/api/debug`;
  const body = JSON.stringify({ caseId: "healthy" });
  const browser = await fetch(url, { method: "POST", headers: { origin: "https://evil.example" }, body });
  assert.equal(browser.status, 403);
  const unauthorized = await fetch(url, { method: "POST", body });
  assert.equal(unauthorized.status, 401);
  const headers = { authorization: "Bearer test-token-123456", "content-type": "application/json" };
  assert.equal((await fetch(url, { method: "POST", headers, body })).status, 200);
  assert.equal((await fetch(url, { method: "POST", headers, body })).status, 429);
});

test("HTTP API rejects work above its concurrency limit", async (context) => {
  const target = createServer((_request, response) => setTimeout(() => response.end("ok"), 100));
  context.after(() => target.close());
  const targetPort = await listen(target);
  const api = createApiServer({ allowedHosts: ["127.0.0.1"], allowedPorts: [targetPort], maxConcurrent: 1 });
  context.after(() => api.close());
  const apiPort = await listen(api);
  const request = () => fetch(`http://127.0.0.1:${apiPort}/api/debug`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind: "curl",
      command: `curl http://127.0.0.1:${targetPort}/slow`,
      spec: { method: "GET", requiredHeaders: {}, requiredBody: {} }
    })
  });
  const first = request();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await request();
  assert.equal(second.status, 429);
  assert.equal((await first).status, 200);
});

test("reasoner call budget blocks repeated paid diagnoses", async () => {
  const task = getCase("rate-limit");
  let calls = 0;
  const reasoner = {
    runtime: { mode: "pi" as const, fallback: "none" as const },
    async diagnose() {
      calls += 1;
      return { rootCause: "RATE_LIMIT_TRANSIENT" as const, summary: "retry", action: { kind: "retry" as const }, evidence: [] };
    }
  };
  const alwaysLimited: HttpTool = { async execute() { return { status: 429, body: {}, headers: {}, durationMs: 1 }; } };
  const report = await new DebugOrchestrator(
    alwaysLimited,
    reasoner,
    undefined,
    new RequestPolicy({ allowedHosts: ["fixture.local"], allowedPorts: [443], maxAttempts: 5, maxReasonerCalls: 2 })
  ).run(task);
  assert.equal(calls, 2);
  assert.match(report.summary, /MODEL_CALL_BUDGET_EXCEEDED/);
});
