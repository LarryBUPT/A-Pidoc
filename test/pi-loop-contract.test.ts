import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, rm } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { runAgentLoopContinue, type StreamFn } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { harness, task, tool } from "./harness-helpers.js";
import { PiLoopAdapter } from "../src/harness/pi-loop-adapter.js";
import { TrajectoryStore, appendStep } from "../src/harness/trajectory-store.js";
import { ToolRegistry } from "../src/harness/tool-registry.js";
import { digest } from "../src/harness/digest.js";

test("Pi 0.85.1 chooses its next tool from real preceding observations", async t => {
  const h = await harness(t, [tool("observe"), tool("read_spec")], [
    fauxAssistantMessage(fauxToolCall("observe", {}, { id: "observe-1" })),
    context => {
      const result = context.messages.find(m => m.role === "toolResult");
      assert.ok(result && JSON.stringify(result).includes("415"));
      return fauxAssistantMessage(fauxToolCall("read_spec", {}, { id: "spec-1" }));
    }, fauxAssistantMessage("The observations support a content type issue.")
  ]);
  const s = await h.adapter.start(task());
  assert.equal(h.provider.state.callCount, 3);
  assert.deepEqual(s.run.steps.filter(v => v.kind === "tool_call").map(v => (v.data as { name: string }).name), ["observe", "read_spec"]);
  assert.equal(s.run.usage.modelCalls, 3); assert.equal(s.run.usage.toolCalls, 2);
  assert.ok(s.run.steps.filter(v => v.kind === "model_turn").every(v => Number.isSafeInteger((v.data as { totalTokens: number }).totalTokens)));
  assert.equal(s.messages.length, 6);
  assert.ok(s.run.steps.every((v, i) => v.seq === i + 1));
});
test("awaited sink is committed before the next provider call", async t => {
  let h: Awaited<ReturnType<typeof harness>>;
  h = await harness(t, [tool()], [fauxAssistantMessage(fauxToolCall("observe", {})), async () => {
    const onDisk = JSON.parse(await readFile(h.store.file, "utf8"));
    assert.ok(onDisk.run.steps.some((v: { kind: string }) => v.kind === "tool_result"));
    return fauxAssistantMessage("done");
  }]);
  assert.notEqual((await h.adapter.start(task())).run.state, "failed");
});
test("blocked mixed batch bypasses afterTool but persists both results and stops gracefully", async t => {
  let h: Awaited<ReturnType<typeof harness>>, after = 0, executions = 0;
  h = await harness(t, [tool("observe", async () => { executions++; return { success: true, data: {}, evidence: [], warnings: [], durationMs: 0, redacted: true }; }), tool("write")], [fauxAssistantMessage([fauxToolCall("observe", {}), fauxToolCall("write", {})]), fauxAssistantMessage("must not run")], {
    beforeTool: async call => {
      if (call.name !== "write") return undefined;
      await h.store.transact(s => { s.run.state = "waiting_approval"; appendStep(s, "policy", { decision: "require_approval" }); });
      return { block: true, terminate: true, reason: "APPROVAL_REQUIRED" };
    }, afterTool: async () => { after++; }
  });
  const s = await h.adapter.start(task());
  assert.equal(s.run.state, "waiting_approval"); assert.equal(h.provider.state.callCount, 1);
  assert.equal(after, 1); assert.equal(executions, 1);
  assert.equal(s.run.steps.filter(v => v.kind === "tool_result").length, 2);
  assert.ok(s.run.steps.some(v => JSON.stringify(v.data).includes("agent_end")));
  assert.equal((await h.adapter.continue()).run.usage.modelCalls, 1);
});
test("new adapter restores standard user continuation without replacing history", async t => {
  const h = await harness(t, [], [fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
  await h.adapter.start(task());
  await h.store.transact(s => s.messages.push({ role: "user", content: "Continue", timestamp: Date.now() }));
  const restored = new PiLoopAdapter(new TrajectoryStore(h.store.file), h.registry, h.options);
  const s = await restored.continue();
  assert.equal(s.messages.length, 4); assert.equal(s.run.usage.modelCalls, 2);
});
test("release continue rejects empty and assistant-ended context", async t => {
  const h = await harness(t, [], []);
  const config = { model: h.provider.getModel(), convertToLlm: () => [], toolExecution: "sequential" as const };
  await assert.rejects(runAgentLoopContinue({ systemPrompt: "", messages: [] }, config, () => {}, undefined, streamSimple), /no messages/);
  await assert.rejects(runAgentLoopContinue({ systemPrompt: "", messages: [fauxAssistantMessage("end")] }, config, () => {}, undefined, streamSimple), /assistant/);
});
test("global sequential overrides parallel-safe metadata", async t => {
  let active = 0, peak = 0;
  const observed = tool("observe", async () => { active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return { success: true, data: {}, evidence: [], warnings: [], durationMs: 10, redacted: true }; });
  const h = await harness(t, [observed], [fauxAssistantMessage([fauxToolCall("observe", {}), fauxToolCall("observe", {})]), fauxAssistantMessage("done")]);
  await h.adapter.start(task()); assert.equal(peak, 1);
});
test("model and tool budgets stop additional turns and calls", async t => {
  let n = 0;
  const h = await harness(t, [tool("observe", async () => { n++; return { success: true, data: {}, evidence: [], warnings: [], durationMs: 0, redacted: true }; })], [fauxAssistantMessage([fauxToolCall("observe", {}), fauxToolCall("observe", {})]), fauxAssistantMessage("must not run")]);
  const input = task(); input.budget.maxModelCalls = 1; input.budget.maxToolCalls = 1;
  const s = await h.adapter.start(input); assert.equal(n, 1); assert.equal(s.run.state, "blocked"); assert.equal(h.provider.state.callCount, 1);
});
test("Harness model retry records attempts and cannot exceed the shared model-call budget", async t => {
  const h = await harness(t, [], [fauxAssistantMessage("done")]);
  let providerCalls = 0, now = 0;
  const providerFetch = (async () => new Response(providerCalls++ === 0 ? "busy" : "ok", { status: providerCalls === 1 ? 503 : 200 })) as typeof globalThis.fetch;
  const streamFn: StreamFn = async (model, context, options) => {
    const response = await options?.fetch?.("https://provider.test/models");
    if (!response?.ok) throw new Error(`provider status ${response?.status}`);
    return streamSimple(model, context, options);
  };
  const retry = { fetch: providerFetch, now: () => now, random: () => 0.5, sleep: async (ms: number) => { now += ms; }, policy: { baseDelayMs: 100 } };
  const adapter = new PiLoopAdapter(h.store, h.registry, { ...h.options, streamFn, retry });
  const input = task(); input.budget.maxModelCalls = 2;
  const state = await adapter.start(input);
  assert.equal(state.run.state, "blocked");
  assert.equal(state.run.usage.modelCalls, 2);
  assert.equal(providerCalls, 2);
  const retries = state.run.steps.filter(step => step.kind === "runtime" && (step.data as { type?: string }).type === "provider_retry");
  assert.equal(retries.length, 2);
  assert.ok(retries.some(step => (step.data as { retry?: { type?: string } }).retry?.type === "retry_attempt"));
});
test("provider and tool errors cannot leak their original secret", async t => {
  const h = await harness(t, [tool("observe", async () => { throw new Error("sk-private-secret-123456"); })], [fauxAssistantMessage(fauxToolCall("observe", {})), fauxAssistantMessage("provider failed", { stopReason: "error", errorMessage: "sk-private-secret-123456" })]);
  const s = await h.adapter.start(task()); assert.equal(s.run.state, "failed"); assert.doesNotMatch(JSON.stringify(s), /private-secret/);
});
test("trajectory transactions are atomic, CAS guarded and cross-process locked", async t => {
  const h = await harness(t, [], [fauxAssistantMessage("done")]); await h.adapter.start(task());
  const revision = (await h.store.load()).stateRevision;
  await h.store.transact(s => appendStep(s, "policy", { decision: "allow" }), revision);
  await assert.rejects(h.store.transact(s => { s.run.state = "blocked"; }, revision), /REVISION_CONFLICT/);
  await assert.rejects(h.store.transact(s => { s.run.state = "blocked"; throw new Error("failed transaction"); }));
  assert.equal((await h.store.load()).run.state, "running");
  await mkdir(`${h.store.file}.lock`);
  await assert.rejects(new TrajectoryStore(h.store.file).transact(() => {}), /EEXIST/);
  await rm(`${h.store.file}.lock`, { recursive: true });
});
test("closed schemas, duplicate tool names and non-JSON digests are rejected", () => {
  assert.throws(() => new ToolRegistry([tool(), tool()]), /REGISTRY/);
  assert.throws(() => new ToolRegistry([{ ...tool(), inputSchema: { type: "object" } }]), /SCHEMA/);
  assert.equal(digest({ b: 2, a: 1 }), digest({ a: 1, b: 2 }));
  assert.throws(() => digest({ amount: NaN }), /NON_JSON/);
});
