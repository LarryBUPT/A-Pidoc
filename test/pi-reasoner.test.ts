import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  fauxAssistantMessage,
  registerFauxProvider,
  streamSimple,
  type Context
} from "@earendil-works/pi-ai";
import { DeterministicReasoner } from "../src/agent/deterministic-reasoner.js";
import { PiReasoner } from "../src/agent/pi-reasoner.js";
import { createConfiguredReasoner } from "../src/config/reasoner.js";
import { DebugOrchestrator } from "../src/core/orchestrator.js";
import type { HttpTool, Reasoner } from "../src/domain/types.js";
import { getCase } from "../src/fixtures/cases.js";
import { RequestPolicy } from "../src/security/request-policy.js";
import { FixtureHttpTool } from "../src/tools/fixture-http-tool.js";

let providerIndex = 0;

const validOutput = JSON.stringify({
  rootCause: "CONTENT_TYPE_MISMATCH",
  summary: "Content-Type does not match the JSON API specification.",
  action: { kind: "set_header", name: "Content-Type", value: "application/json" }
});

function input(): Parameters<Reasoner["diagnose"]>[0] {
  return {
    request: {
      method: "POST",
      url: "https://fixture.local/orders?api_key=query-secret",
      headers: { Authorization: "Bearer header-secret", "Content-Type": "text/plain" },
      body: { amount: 12, password: "body-secret" }
    },
    spec: {
      method: "POST",
      requiredHeaders: { Authorization: "Bearer spec-secret", "Content-Type": "application/json" },
      requiredBody: { amount: "number" }
    },
    result: {
      status: 415,
      body: { error: "unsupported media type", token: "response-secret" },
      headers: { cookie: "response-cookie" },
      durationMs: 1
    },
    rules: [{ id: "content-type", statuses: [415], keywords: ["media"], guidance: "Use the documented content type." }]
  };
}

function fauxReasoner(
  context: TestContext,
  response: string | ((agentContext: Context) => ReturnType<typeof fauxAssistantMessage>),
  fallback?: Reasoner
): { reasoner: PiReasoner; calls: () => number } {
  const provider = registerFauxProvider({
    provider: `a-pidoc-test-${++providerIndex}`,
    models: [{ id: "debug-model", input: ["text"] }]
  });
  context.after(() => provider.unregister());
  provider.setResponses([
    typeof response === "string"
      ? fauxAssistantMessage(response)
      : (agentContext) => response(agentContext)
  ]);
  return {
    reasoner: new PiReasoner({
      model: provider.getModel(),
      ...(fallback ? { fallback } : {})
    }),
    calls: () => provider.state.callCount
  };
}

test("PiReasoner instantiates Pi Agent and accepts a constrained diagnosis", async (context) => {
  const harness = fauxReasoner(context, validOutput);
  const diagnosis = await harness.reasoner.diagnose(input());

  assert.equal(harness.calls(), 1);
  assert.equal(diagnosis.rootCause, "CONTENT_TYPE_MISMATCH");
  assert.deepEqual(diagnosis.action, { kind: "set_header", name: "Content-Type", value: "application/json" });
  assert.ok(diagnosis.evidence.every((item) => item.source !== undefined));
});

test("PiReasoner forwards output, retry, and timeout budgets to the provider", async (context) => {
  const provider = registerFauxProvider({
    provider: `a-pidoc-test-${++providerIndex}`,
    models: [{ id: "bounded-model", input: ["text"] }]
  });
  context.after(() => provider.unregister());
  provider.setResponses([fauxAssistantMessage(validOutput)]);
  let captured: Parameters<typeof streamSimple>[2];
  const reasoner = new PiReasoner({
    model: provider.getModel(),
    maxOutputTokens: 1024,
    timeoutMs: 1234,
    streamFn: (model, agentContext, options) => {
      captured = options;
      return streamSimple(model, agentContext, options);
    }
  });
  const diagnosis = await reasoner.diagnose(input());
  assert.equal(captured?.maxTokens, 1024);
  assert.equal(captured?.maxRetries, 0);
  assert.equal(captured?.timeoutMs, 1234);
  assert.equal(typeof diagnosis.modelUsage?.totalTokens, "number");
});

test("PiReasoner accepts JSON enclosed in a markdown code fence", async (context) => {
  const { reasoner } = fauxReasoner(context, `\`\`\`json\n${validOutput}\n\`\`\``);
  assert.equal((await reasoner.diagnose(input())).rootCause, "CONTENT_TYPE_MISMATCH");
});

test("Pi supports new fault categories and rejects a typed but invented repair value", async (context) => {
  const invalid = input();
  invalid.result.status = 422;
  invalid.request.body = { amount: "12" };
  const invented = fauxReasoner(context, JSON.stringify({ rootCause: "BODY_TYPE_MISMATCH", summary: "Change amount", action: { kind: "set_body", name: "amount", value: 9000 } }));
  await assert.rejects(() => invented.reasoner.diagnose(invalid), /actual request evidence/);
  for (const [status, rootCause] of [[403, "PERMISSION_DENIED"], [404, "ENDPOINT_NOT_FOUND"], [503, "SERVER_ERROR"]] as const) {
    const failed = input();
    failed.result.status = status;
    const safe = fauxReasoner(context, JSON.stringify({ rootCause, summary: "Manual follow-up required", action: { kind: "stop" } }));
    assert.equal((await safe.reasoner.diagnose(failed)).rootCause, rootCause);
  }
});

test("PiReasoner accepts only specification-backed method, body, and auth plans", async (context) => {
  const methodInput = input();
  methodInput.result.status = 405;
  methodInput.request.method = "GET";
  const method = fauxReasoner(context, JSON.stringify({
    rootCause: "HTTP_METHOD_MISMATCH",
    summary: "Use the documented method.",
    action: { kind: "set_method", value: "POST" }
  }));
  assert.deepEqual((await method.reasoner.diagnose(methodInput)).action, { kind: "set_method", value: "POST" });

  const bodyInput = input();
  bodyInput.result.status = 422;
  bodyInput.request.body = { amount: "12" };
  const body = fauxReasoner(context, JSON.stringify({
    rootCause: "BODY_TYPE_MISMATCH",
    summary: "Convert amount to the documented number type.",
    action: { kind: "set_body", name: "amount", value: 12 }
  }));
  assert.deepEqual((await body.reasoner.diagnose(bodyInput)).action, { kind: "set_body", name: "amount", value: 12 });

  const authInput = input();
  authInput.result.status = 401;
  const auth = fauxReasoner(context, JSON.stringify({
    rootCause: "AUTH_HEADER_FORMAT",
    summary: "Credentials cannot be repaired safely.",
    action: { kind: "stop" }
  }));
  assert.deepEqual((await auth.reasoner.diagnose(authInput)).action, { kind: "stop" });
});

test("PiReasoner rejects malformed JSON without an implicit fallback", async (context) => {
  const { reasoner } = fauxReasoner(context, "not-json");
  await assert.rejects(() => reasoner.diagnose(input()), /model output is not valid JSON/);
});

test("PiReasoner rejects unknown and sensitive actions", async (context) => {
  const unknown = fauxReasoner(context, JSON.stringify({
    rootCause: "CONTENT_TYPE_MISMATCH",
    summary: "bad plan",
    action: { kind: "run_shell", command: "echo unsafe" }
  }));
  await assert.rejects(() => unknown.reasoner.diagnose(input()), /unknown or missing action kind/);

  const sensitive = fauxReasoner(context, JSON.stringify({
    rootCause: "CONTENT_TYPE_MISMATCH",
    summary: "bad credential plan",
    action: { kind: "set_header", name: "Authorization", value: "Bearer invented" }
  }));
  await assert.rejects(() => sensitive.reasoner.diagnose(input()), /sensitive header changes are forbidden/);
});

test("PiReasoner surfaces model failures when fallback is disabled", async (context) => {
  const { reasoner } = fauxReasoner(context, () => fauxAssistantMessage("", {
    stopReason: "error",
    errorMessage: "provider unavailable"
  }));
  await assert.rejects(() => reasoner.diagnose(input()), /provider request failed/);
});

test("PiReasoner aborts a model call when its diagnosis timeout expires", async (context) => {
  const provider = registerFauxProvider({
    provider: `a-pidoc-test-${++providerIndex}`,
    models: [{ id: "slow-model", input: ["text"] }],
    tokensPerSecond: 100
  });
  context.after(() => provider.unregister());
  provider.setResponses([fauxAssistantMessage(validOutput)]);
  const reasoner = new PiReasoner({ model: provider.getModel(), timeoutMs: 100 });

  await assert.rejects(() => reasoner.diagnose(input()), /model timed out after 100ms/);
});

test("PiReasoner uses only an explicitly configured deterministic fallback", async (context) => {
  const { reasoner } = fauxReasoner(context, "not-json", new DeterministicReasoner());
  const diagnosis = await reasoner.diagnose(input());

  assert.equal(diagnosis.rootCause, "CONTENT_TYPE_MISMATCH");
  assert.match(diagnosis.evidence.at(-1)?.detail ?? "", /显式配置/);
  assert.equal(reasoner.runtime.fallback, "deterministic");
});

test("Pi prompt redacts secrets before provider execution", async (context) => {
  let captured = "";
  const { reasoner } = fauxReasoner(context, (agentContext) => {
    captured = JSON.stringify(agentContext);
    return fauxAssistantMessage(validOutput);
  });
  await reasoner.diagnose(input());

  for (const secret of ["query-secret", "header-secret", "body-secret", "spec-secret", "response-secret", "response-cookie"]) {
    assert.doesNotMatch(captured, new RegExp(secret));
  }
  assert.match(captured, /\[REDACTED\]/);
});

test("Pi Agent runs through Orchestrator, HTTP Tool, Reviewer, and Trace", async (context) => {
  const caseData = getCase("content-type");
  const { reasoner } = fauxReasoner(context, validOutput);
  const report = await new DebugOrchestrator(
    new FixtureHttpTool(caseData),
    reasoner,
    undefined,
    new RequestPolicy({ allowedHosts: ["fixture.local"], allowedPorts: [443] })
  ).run(caseData, { expectedRootCause: caseData.expectedRootCause });

  assert.equal(report.status, "resolved");
  assert.equal(report.evaluation.passed, true);
  assert.equal(report.attempts.length, 2);
  const piTrace = report.trace.find((event) => event.stage === "diagnose_and_plan" && event.status === "succeeded");
  assert.deepEqual(piTrace?.metadata, {
    mode: "pi",
    provider: reasoner.runtime.provider,
    model: "debug-model",
    promptVersion: "v1.1.0",
    timeoutMs: 30000,
    maxOutputTokens: 2048,
    maxPromptBytes: 32768,
    fallback: "none"
  });
});

test("policy blocks an unlisted host before Pi is called", async (context) => {
  const harness = fauxReasoner(context, validOutput);
  const caseData = getCase("content-type");
  caseData.request.url = "https://blocked.example/orders";
  const report = await new DebugOrchestrator(
    new FixtureHttpTool(caseData),
    harness.reasoner,
    undefined,
    new RequestPolicy({ allowedHosts: ["fixture.local"], allowedPorts: [443] })
  ).run(caseData);

  assert.equal(report.status, "blocked");
  assert.equal(harness.calls(), 0);
});

test("maximum attempt policy still limits Pi retry plans", async (context) => {
  const provider = registerFauxProvider({
    provider: `a-pidoc-test-${++providerIndex}`,
    models: [{ id: "retry-model", input: ["text"] }]
  });
  context.after(() => provider.unregister());
  const retry = fauxAssistantMessage(JSON.stringify({
    rootCause: "RATE_LIMIT_TRANSIENT",
    summary: "retry after transient rate limiting",
    action: { kind: "retry" }
  }));
  provider.setResponses([retry, retry, retry]);
  const reasoner = new PiReasoner({ model: provider.getModel() });
  const alwaysLimited: HttpTool = {
    async execute() {
      return { status: 429, body: { error: "limited" }, headers: {}, durationMs: 1 };
    }
  };
  const task = getCase("rate-limit");
  const report = await new DebugOrchestrator(
    alwaysLimited,
    reasoner,
    undefined,
    new RequestPolicy({ allowedHosts: ["fixture.local"], allowedPorts: [443], maxAttempts: 3, maxReasonerCalls: 2 })
  ).run(task);

  assert.equal(report.attempts.length, 3);
  assert.equal(provider.state.callCount, 2);
  assert.equal(report.status, "blocked");
  assert.match(report.summary, /MODEL_CALL_BUDGET_EXCEEDED/);
});

test("Pi environment configuration defaults to DeepSeek V4 Pro and fails fast without a credential", () => {
  assert.throws(
    () => createConfiguredReasoner({ A_PIDOC_REASONER: "pi" }),
    /requires A_PIDOC_PI_API_KEY or a provider credential for deepseek/
  );
  assert.throws(
    () => createConfiguredReasoner({
      A_PIDOC_REASONER: "pi",
      A_PIDOC_PI_PROVIDER: "deepseek",
      A_PIDOC_PI_MODEL: "missing-model"
    }),
    /Unknown Pi model/
  );
  assert.throws(
    () => createConfiguredReasoner({
      A_PIDOC_REASONER: "pi",
      A_PIDOC_PI_PROVIDER: "zai",
      A_PIDOC_PI_MODEL: "glm-4.7"
    }),
    /requires A_PIDOC_PI_API_KEY or a provider credential/
  );
  assert.throws(
    () => createConfiguredReasoner({ A_PIDOC_REASONER: "surprise" }),
    /must be deterministic or pi/
  );
  const configured = createConfiguredReasoner({
    A_PIDOC_REASONER: "pi",
    A_PIDOC_PI_API_KEY: "test-only-key",
    A_PIDOC_PI_FALLBACK: "deterministic"
  });
  assert.deepEqual(configured.runtime, {
    mode: "pi",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    promptVersion: "v1.1.0",
    timeoutMs: 30000,
    maxOutputTokens: 2048,
    maxPromptBytes: 32768,
    fallback: "deterministic"
  });
  assert.throws(
    () => createConfiguredReasoner({
      A_PIDOC_REASONER: "pi",
      A_PIDOC_PI_API_KEY: "test-only-key",
      A_PIDOC_PI_TIMEOUT_MS: "0"
    }),
    /A_PIDOC_PI_TIMEOUT_MS must be an integer between 100 and 300000/
  );
});
