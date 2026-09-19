import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetryingModelFetch,
  exponentialDelayMs,
  type ModelRetryEvent,
  type ModelRetryPolicy
} from "../src/model/model-retry.js";

const policy: ModelRetryPolicy = { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 2_000, maxTotalWaitMs: 4_000, jitterRatio: 0.2 };

function deterministic(responses: Array<Response | Error>, overrides: Partial<ModelRetryPolicy> = {}) {
  let now = 1_000, calls = 0;
  const waits: number[] = [], events: ModelRetryEvent[] = [];
  const fetch = createRetryingModelFetch({
    policy: { ...policy, ...overrides }, deadlineMs: 10_000,
    now: () => now, random: () => 0.5,
    sleep: async ms => { waits.push(ms); now += ms; },
    fetch: (async () => { const value = responses[calls++]; if (value instanceof Error) throw value; return value!; }) as typeof globalThis.fetch,
    onEvent: event => { events.push(event); }
  });
  return { fetch, calls: () => calls, waits, events, now: () => now };
}

test("model retry returns first success without waiting", async () => {
  const h = deterministic([new Response("ok", { status: 200 })]);
  assert.equal((await h.fetch("https://provider.test")).status, 200);
  assert.equal(h.calls(), 1); assert.deepEqual(h.waits, []);
  assert.deepEqual(h.events, [{ type: "initial_request", attempt: 1 }]);
});

test("429 honors Retry-After and 503 uses deterministic exponential backoff", async () => {
  const rate = deterministic([new Response("busy", { status: 429, headers: { "Retry-After": "1" } }), new Response("ok", { status: 200 })]);
  assert.equal((await rate.fetch("https://provider.test")).status, 200);
  assert.deepEqual(rate.waits, [1_000]); assert.equal(rate.calls(), 2);
  assert.ok(rate.events.some(e => e.type === "retry_scheduled" && e.retryAfterMs === 1_000));

  const unavailable = deterministic([new Response("a", { status: 503 }), new Response("b", { status: 503 }), new Response("ok", { status: 200 })]);
  assert.equal((await unavailable.fetch("https://provider.test")).status, 200);
  assert.deepEqual(unavailable.waits, [100, 200]); assert.equal(unavailable.calls(), 3);
});

test("bounded jitter stays inside the configured interval", () => {
  assert.equal(exponentialDelayMs(1, policy, () => 0), 80);
  assert.equal(exponentialDelayMs(1, policy, () => 1), 120);
  assert.equal(exponentialDelayMs(2, policy, () => 0.5), 200);
  assert.equal(exponentialDelayMs(1, policy, () => Number.NaN), 100);
  assert.equal(exponentialDelayMs(1, policy, () => Number.POSITIVE_INFINITY), 100);
});

test("authentication and malformed requests are never retried", async () => {
  for (const status of [400, 401, 403, 422]) {
    const h = deterministic([new Response("terminal", { status, headers: { "x-should-retry": "true" } })]);
    assert.equal((await h.fetch("https://provider.test")).status, status);
    assert.equal(h.calls(), 1); assert.deepEqual(h.waits, []);
  }
});

test("retry exhaustion and duration budget stop without real sleeps", async () => {
  const exhausted = deterministic([new Response("a", { status: 503 }), new Response("b", { status: 503 })], { maxRetries: 1 });
  assert.equal((await exhausted.fetch("https://provider.test")).status, 503);
  assert.equal(exhausted.calls(), 2); assert.deepEqual(exhausted.waits, [100]);
  assert.ok(exhausted.events.some(e => e.type === "retry_exhausted" && e.limit === "attempts"));

  let calls = 0, slept = false;
  const events: ModelRetryEvent[] = [];
  const bounded = createRetryingModelFetch({
    policy, deadlineMs: 50, now: () => 0, random: () => 0.5,
    sleep: async () => { slept = true; },
    fetch: (async () => { calls++; return new Response("busy", { status: 503 }); }) as typeof globalThis.fetch,
    onEvent: event => { events.push(event); }
  });
  assert.equal((await bounded("https://provider.test")).status, 503);
  assert.equal(calls, 1); assert.equal(slept, false);
  assert.ok(events.some(e => e.type === "budget_exhausted" && e.remainingMs === 50));

  const totalWait = deterministic([new Response("a", { status: 503 }), new Response("b", { status: 503 })], { maxTotalWaitMs: 150 });
  assert.equal((await totalWait.fetch("https://provider.test")).status, 503);
  assert.equal(totalWait.calls(), 2); assert.deepEqual(totalWait.waits, [100]);
  assert.ok(totalWait.events.some(e => e.type === "budget_exhausted" && e.requiredWaitMs === 200));
});

test("network transient codes retry while unknown network errors remain unchanged", async () => {
  const temporary = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
  const h = deterministic([temporary, new Response("ok", { status: 200 })]);
  assert.equal((await h.fetch("https://provider.test")).status, 200);
  assert.equal(h.calls(), 2); assert.deepEqual(h.waits, [100]);

  const permanent = Object.assign(new Error("certificate rejected"), { code: "CERT_HAS_EXPIRED" });
  const noRetry = deterministic([permanent]);
  await assert.rejects(noRetry.fetch("https://provider.test"), error => error === permanent);
  assert.equal(noRetry.calls(), 1); assert.deepEqual(noRetry.waits, []);
});

test("Retry-After above the single-wait bound is not shortened into an early retry", async () => {
  const h = deterministic([new Response("busy", { status: 429, headers: { "Retry-After": "10" } })]);
  assert.equal((await h.fetch("https://provider.test")).status, 429);
  assert.equal(h.calls(), 1); assert.deepEqual(h.waits, []);
  assert.ok(h.events.some(e => e.type === "retry_exhausted" && e.limit === "single_wait"));
});

test("stream request bodies are not replayed after a transient response", async () => {
  let calls = 0, slept = false;
  const fetch = createRetryingModelFetch({
    policy, deadlineMs: 10_000, now: () => 0, random: () => 0.5,
    sleep: async () => { slept = true; },
    fetch: (async () => { calls++; return new Response("busy", { status: 503 }); }) as typeof globalThis.fetch
  });
  const body = new ReadableStream<Uint8Array>();
  assert.equal((await fetch("https://provider.test", { method: "POST", body })).status, 503);
  assert.equal(calls, 1);
  assert.equal(slept, false);
});
