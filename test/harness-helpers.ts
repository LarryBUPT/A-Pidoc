import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { registerFauxProvider, streamSimple, type FauxResponseStep } from "@earendil-works/pi-ai/compat";
import type { AgentTask, HarnessTool } from "../src/harness/contracts.js";
import { PiLoopAdapter, type LoopHooks } from "../src/harness/pi-loop-adapter.js";
import { ToolRegistry } from "../src/harness/tool-registry.js";
import { TrajectoryStore } from "../src/harness/trajectory-store.js";
let index = 0;
export function task(): AgentTask {
  return { id: "test-run", goal: "Investigate using tools, then propose a conclusion with evidence.", taskFamily: "test", environment: "sandbox", inputArtifacts: [], allowedToolBundles: ["test"], risk: "low", budget: { maxModelCalls: 8, maxToolCalls: 16, maxTokens: 50_000, maxCostUsd: 1, maxDurationMs: 30_000 } };
}
export function tool(name = "observe", execute: HarnessTool["execute"] = async () => ({ success: true, data: { status: 415 }, evidence: [], warnings: [], durationMs: 1, redacted: true })): HarnessTool {
  return { name, bundle: "test", description: "Observe the isolated API", inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false }, risk: "read", executionMode: "parallel", idempotency: "safe", concurrency: { parallelSafe: true, sideEffectFree: true, snapshotConsistent: true }, execute };
}
export async function harness(t: TestContext, tools: HarnessTool[], responses: FauxResponseStep[], hooks: LoopHooks = {}) {
  const dir = await mkdtemp(join(tmpdir(), "a-pidoc-harness-test-"));
  const provider = registerFauxProvider({ provider: `harness-${++index}`, models: [{ id: "lead", input: ["text"] }] });
  provider.setResponses(responses);
  t.after(async () => { provider.unregister(); await rm(dir, { recursive: true, force: true }); });
  const store = new TrajectoryStore(join(dir, "run.json")), registry = new ToolRegistry(tools);
  const options = { model: provider.getModel(), streamFn: streamSimple, prompt: "Choose a useful tool based on observations. Never claim unexecuted changes.", hooks };
  return { dir, provider, store, registry, options, adapter: new PiLoopAdapter(store, registry, options) };
}
