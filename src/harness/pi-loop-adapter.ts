import { runAgentLoop, runAgentLoopContinue, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import type { AgentTask, RunState } from "./contracts.js";
import { appendStep, TrajectoryStore, type RunSnapshot } from "./trajectory-store.js";
import { ToolRegistry } from "./tool-registry.js";
import { redactValue } from "../security/redaction.js";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface ToolInvocation { id: string; name: string; args: unknown }
export interface LoopHooks {
  beforeTool?: (call: ToolInvocation) => Promise<{ block: true; terminate: true; reason: string } | undefined>;
  afterTool?: (call: ToolInvocation, result: unknown, isError: boolean) => Promise<void>;
  onEvent?: (event: AgentEvent) => Promise<void>;
  shouldStop?: () => Promise<boolean>;
  project?: (messages: unknown[]) => Promise<unknown[]>;
  convert?: (messages: unknown[]) => Message[];
}
export interface PiLoopOptions {
  model: Model<any>; streamFn: StreamFn; apiKey?: string;
  prompt: string; maxOutputTokens?: number; hooks?: LoopHooks;
}
const ACTIVE: RunState[] = ["running", "approval_granted_pending_reissue"];
function budgetExceeded(s: RunSnapshot): boolean {
  const b = s.run.task.budget, u = s.run.usage;
  return u.modelCalls >= b.maxModelCalls || u.toolCalls >= b.maxToolCalls || u.tokens >= b.maxTokens || u.estimatedCostUsd >= b.maxCostUsd || s.elapsedMs >= b.maxDurationMs;
}
function standardMessages(messages: unknown[]): Message[] {
  return messages.filter((m): m is Message => !!m && typeof m === "object" && ["user", "assistant", "toolResult"].includes((m as Message).role));
}
export class PiLoopAdapter {
  private active = false;
  constructor(readonly store: TrajectoryStore, readonly registry: ToolRegistry, private readonly options: PiLoopOptions) {}
  async start(task: AgentTask): Promise<RunSnapshot> {
    if (!task.goal.trim() || Object.values(task.budget).some(v => !Number.isFinite(v) || v <= 0)) throw new Error("INVALID_RUN_BUDGET");
    const message: Message = { role: "user", content: JSON.stringify({ goal: task.goal, taskFamily: task.taskFamily, environment: task.environment }), timestamp: Date.now() };
    await this.store.create({ formatVersion: 1, run: { runId: task.id, task, state: "running", steps: [], usage: { modelCalls: 0, toolCalls: 0, tokens: 0, estimatedCostUsd: 0 }, evidence: [] }, messages: [], stateRevision: 0, workspaceRevision: 0, evidenceSequence: 0, elapsedMs: 0, artifacts: {} });
    return this.drive([message]);
  }
  async continue(): Promise<RunSnapshot> { return this.drive(); }
  private async drive(prompts?: AgentMessage[]): Promise<RunSnapshot> {
    if (this.active) throw new Error("RUN_ALREADY_ACTIVE");
    this.active = true;
    const started = Date.now();
    let s: RunSnapshot;
    const lease = `${this.store.file}.runner.lock`;
    let ownsLease = false;
    try {
      await mkdir(dirname(this.store.file), { recursive: true });
      try { await mkdir(lease); ownsLease = true; } catch { throw new Error("RUN_LEASE_UNAVAILABLE"); }
      s = await this.store.load();
      if (!ACTIVE.includes(s.run.state)) return s;
      if (s.executionInDoubt) {
        return await this.store.transact(v => { v.run.state = "blocked"; appendStep(v, "state_transition", { code: "EXECUTION_IN_DOUBT" }); });
      }
      if (budgetExceeded(s)) return await this.store.transact(v => { v.run.state = "blocked"; appendStep(v, "state_transition", { code: "RUN_BUDGET_EXHAUSTED" }); });
      const hooks = this.options.hooks ?? {};
      const context: AgentContext = { systemPrompt: this.options.prompt, messages: structuredClone(s.messages) as AgentMessage[], tools: this.registry.toPiTools(s.run.task) };
      const config: AgentLoopConfig = {
        model: this.options.model, toolExecution: "sequential", maxRetries: 0,
        maxTokens: this.options.maxOutputTokens ?? 2048,
        ...(this.options.apiKey ? { getApiKey: () => this.options.apiKey } : {}),
        convertToLlm: messages => {
          try { return hooks.convert ? hooks.convert(messages) : standardMessages(messages); } catch { return standardMessages(messages); }
        },
        transformContext: async messages => {
          try { return hooks.project ? await hooks.project(messages) as AgentMessage[] : messages; } catch { return messages; }
        },
        beforeToolCall: async h => {
          const call = { id: h.toolCall.id, name: h.toolCall.name, args: h.args };
          const state = await this.store.load();
          if (!ACTIVE.includes(state.run.state)) return { block: true, terminate: true, reason: "RUN_SUSPENDED" };
          const tool = this.registry.get(call.name);
          if (!tool || !state.run.task.allowedToolBundles.includes(tool.bundle)) return { block: true, terminate: true, reason: "TOOL_NOT_ALLOWED" };
          if (state.run.usage.toolCalls > state.run.task.budget.maxToolCalls) {
            await this.store.transact(v => { v.run.state = "blocked"; appendStep(v, "policy", { decision: "block", code: "TOOL_BUDGET_EXHAUSTED" }); });
            return { block: true, terminate: true, reason: "TOOL_BUDGET_EXHAUSTED" };
          }
          if (hooks.beforeTool) {
            try { return await hooks.beforeTool(call); } catch {
              await this.store.transact(v => { v.run.state = "failed"; appendStep(v, "policy", { decision: "block", code: "GUARDRAIL_FAILED" }); });
              return { block: true, terminate: true, reason: "GUARDRAIL_FAILED" };
            }
          }
          const allowed = tool.risk === "read";
          await this.store.transact(v => { appendStep(v, "policy", { toolCallId: call.id, decision: allowed ? "allow" : "block", code: allowed ? "READ_ONLY_BASELINE" : "GUARDRAIL_REQUIRED" }); if (!allowed) v.run.state = "blocked"; });
          return allowed ? undefined : { block: true, terminate: true, reason: "GUARDRAIL_REQUIRED" };
        },
        afterToolCall: async h => { await hooks.afterTool?.({ id: h.toolCall.id, name: h.toolCall.name, args: h.args }, h.result.details, h.isError); return undefined; },
        shouldStopAfterTurn: async () => {
          const state = await this.store.load();
          if (!ACTIVE.includes(state.run.state) || await hooks.shouldStop?.()) return true;
          if (budgetExceeded(state)) {
            await this.store.transact(v => { v.run.state = "blocked"; appendStep(v, "state_transition", { code: "RUN_BUDGET_EXHAUSTED" }); }); return true;
          }
          return false;
        }
      };
      const stream: StreamFn = async (model, llmContext, requestOptions) => {
        try {
          const state = await this.store.load();
          if (!ACTIVE.includes(state.run.state) || budgetExceeded(state) || Buffer.byteLength(JSON.stringify(llmContext)) > 131_072) throw new Error("RUN_BUDGET_EXHAUSTED");
          await this.store.transact(v => { v.run.usage.modelCalls++; appendStep(v, "runtime", { type: "provider_request", execution: "sequential", model: model.id, provider: model.provider }); });
          return await this.options.streamFn(model, llmContext, { ...requestOptions, maxRetries: 0, maxTokens: Math.min(this.options.maxOutputTokens ?? 2048, state.run.task.budget.maxTokens - state.run.usage.tokens), timeoutMs: Math.max(1, state.run.task.budget.maxDurationMs - state.elapsedMs), ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}) });
        } catch {
          const result: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "PI_PROVIDER_OR_BUDGET_ERROR", timestamp: Date.now() };
          const failed = createAssistantMessageEventStream(); failed.push({ type: "error", reason: "error", error: result }); failed.end(result); return failed;
        }
      };
      const emit = async (event: AgentEvent): Promise<void> => {
        // message_end is the authoritative transcript, not streaming deltas.
        if (!["message_end", "tool_execution_start", "tool_execution_end", "turn_end", "agent_end"].includes(event.type)) { await hooks.onEvent?.(event); return; }
        await this.store.transact(v => {
          if (event.type === "message_end") {
            const message = structuredClone(event.message);
            if (message.role === "assistant") {
              const safe = redactValue(message) as AssistantMessage;
              safe.usage = message.usage; // Token/cost counters are structural fields.
              delete safe.errorMessage; v.messages.push(safe);
              v.run.usage.tokens += message.usage.totalTokens; v.run.usage.estimatedCostUsd += message.usage.cost.total;
              appendStep(v, "model_turn", { stopReason: message.stopReason, content: safe.content, totalTokens: message.usage.totalTokens, costUsd: message.usage.cost.total });
              if (["error", "aborted"].includes(message.stopReason)) v.run.state = "failed";
            } else v.messages.push(redactValue(message));
          }
          if (event.type === "tool_execution_start") { v.run.usage.toolCalls++; appendStep(v, "tool_call", { id: event.toolCallId, name: event.toolName, args: event.args }); }
          if (event.type === "tool_execution_end") appendStep(v, "tool_result", { id: event.toolCallId, name: event.toolName, result: event.result, isError: event.isError });
          if (["turn_end", "agent_end"].includes(event.type)) appendStep(v, "runtime", { type: event.type });
        });
        await hooks.onEvent?.(event);
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, s.run.task.budget.maxDurationMs - s.elapsedMs));
      timer.unref();
      try {
        if (prompts) await runAgentLoop(prompts, context, config, emit, controller.signal, stream);
        else await runAgentLoopContinue(context, config, emit, controller.signal, stream);
      } finally { clearTimeout(timer); }
      return await this.store.transact(v => { v.elapsedMs += Date.now() - started; });
    } catch {
      if (!ownsLease) throw new Error("RUN_LEASE_UNAVAILABLE");
      // Persistence failures reject: never continue an unaudited tool run.
      await this.store.transact(v => { v.run.state = "failed"; appendStep(v, "state_transition", { code: "PI_LOOP_FAILED" }); });
      return this.store.load();
    } finally { if (ownsLease) await rm(lease, { recursive: true }); this.active = false; }
  }
}
