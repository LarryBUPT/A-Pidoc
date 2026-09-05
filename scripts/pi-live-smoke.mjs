import assert from "node:assert/strict";
import { createConfiguredReasoner } from "../dist/src/config/reasoner.js";

const EXPECTED_PROVIDER = "deepseek";
const EXPECTED_MODEL = "deepseek-v4-pro";
const PLACEHOLDER = "replace-with-your-deepseek-api-key";

function safeErrorMessage(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const credential of [process.env.DEEPSEEK_API_KEY, process.env.A_PIDOC_PI_API_KEY]) {
    if (!credential) continue;
    message = message.replaceAll(credential, "[REDACTED]");
    if (credential.length >= 4) message = message.replaceAll(credential.slice(-4), "[REDACTED]");
  }
  return message;
}

const credential = process.env.A_PIDOC_PI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
if (!credential || credential === PLACEHOLDER) {
  console.error("Live Pi smoke test requires a real API key in the ignored .env file.");
  process.exit(1);
}

try {
  const reasoner = createConfiguredReasoner();
  assert.deepEqual(reasoner.runtime, {
    mode: "pi",
    provider: EXPECTED_PROVIDER,
    model: EXPECTED_MODEL,
    promptVersion: "v1.0.0",
    timeoutMs: 30000,
    fallback: "none"
  });

  const diagnosis = await reasoner.diagnose({
    request: {
      method: "POST",
      url: "https://fixture.local/orders",
      headers: { "Content-Type": "text/plain" },
      body: { amount: 12 }
    },
    spec: {
      method: "POST",
      requiredHeaders: { "Content-Type": "application/json" },
      requiredBody: { amount: "number" }
    },
    result: {
      status: 415,
      body: { error: "unsupported media type" },
      headers: {},
      durationMs: 1
    },
    rules: []
  });

  assert.equal(diagnosis.rootCause, "CONTENT_TYPE_MISMATCH");
  assert.deepEqual(diagnosis.action, {
    kind: "set_header",
    name: "Content-Type",
    value: "application/json"
  });
  console.log(JSON.stringify({
    passed: true,
    provider: reasoner.runtime.provider,
    model: reasoner.runtime.model,
    fallback: reasoner.runtime.fallback,
    rootCause: diagnosis.rootCause,
    action: diagnosis.action.kind
  }, null, 2));
} catch (error) {
  console.error(`Live Pi smoke test failed: ${safeErrorMessage(error)}`);
  process.exitCode = 1;
}
