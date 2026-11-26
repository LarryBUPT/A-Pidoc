import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { AgentHarnessRuntime } from "../kernel/harness.js";
import { SessionStore } from "../kernel/session-store.js";
import { SkillRegistry } from "../kernel/skill-loader.js";
import type { HarnessEventListener } from "../kernel/telemetry.js";
import type { HarnessEvent, RunSnapshot, TaskKind } from "../kernel/types.js";
import { resolveLiveModel } from "../shared/model-factory.js";
import type { RuntimeEnvironment } from "../shared/types.js";
import { createCoreHarnessTools } from "../tools/core-tools.js";
import { createHttpTools } from "../tools/http-runner.js";
import { createOpenApiTools, OpenApiIndex } from "../tools/openapi-search.js";
import { ToolRegistry } from "../tools/registry.js";
import { buildDemoOpenApiSpec } from "./demo-sandbox.js";
import { createDemoMockStream, MOCK_MODEL } from "./mock-stream.js";

export interface CreateRunRequest {
  title?: string;
  goal: string;
  kind?: TaskKind;
  environment?: RuntimeEnvironment;
  mode?: "live" | "mock";
  mockScenario?: "orders-debug" | "payment-approval";
  openApiDocument?: unknown;
  allowedHosts?: string[];
  allowedPorts?: number[];
  requireApprovalForMutations?: boolean;
  enableReviewer?: boolean;
}

interface ActiveRunEntry {
  runtime: AgentHarnessRuntime;
  controller: AbortController;
  listeners: Set<HarnessEventListener>;
}

/**
 * 后端异步运行管理器：
 * - 统一调度 live（DeepSeek）和 mock（免密钥演示）任务
 * - 管理每个 runId 的实时事件广播（供 Hono SSE 推送给 Vue 前端）
 * - 支持人工审批后无缝恢复执行与任务取消
 */
export class RunManager {
  readonly store: SessionStore;
  readonly skills: SkillRegistry;
  private readonly activeRuns = new Map<string, ActiveRunEntry>();
  private readonly runRuntimes = new Map<string, AgentHarnessRuntime>();
  private readonly memoryEvents = new Map<string, HarnessEvent[]>();

  constructor(
    private readonly baseUrl: string,
    runsDir = resolve(".private/runs")
  ) {
    this.store = new SessionStore(runsDir);
    this.skills = new SkillRegistry();
  }

  async initialize(): Promise<void> {
    await this.skills.loadFromDirectory(resolve(".pi/skills"));
  }

  async getEvents(runId: string): Promise<HarnessEvent[]> {
    const cached = this.memoryEvents.get(runId);
    if (cached && cached.length > 0) {
      return [...cached];
    }
    const disk = await this.store.readEvents(runId);
    if (disk.length > 0) {
      this.memoryEvents.set(runId, disk);
    }
    return disk;
  }

  clearRunMemory(runId: string): void {
    this.memoryEvents.delete(runId);
    this.runRuntimes.delete(runId);
  }

  subscribe(runId: string, listener: HarnessEventListener): () => void {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      const dummy = () => {};
      return dummy;
    }
    entry.listeners.add(listener);
    return () => {
      entry.listeners.delete(listener);
    };
  }

  isRunning(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  private broadcast(runId: string, event: HarnessEvent): void {
    const list = this.memoryEvents.get(runId) ?? [];
    if (!list.some((item) => item.seq === event.seq)) {
      list.push(event);
      this.memoryEvents.set(runId, list);
    }
    const entry = this.activeRuns.get(runId);
    if (!entry) return;
    for (const listener of entry.listeners) {
      try {
        listener(event);
      } catch {
        // 忽略失效连接
      }
    }
  }

  private buildRuntime(request: CreateRunRequest): AgentHarnessRuntime {
    const mode = request.mode ?? (process.env.DEEPSEEK_API_KEY ? "live" : "mock");
    const openApiDoc = request.openApiDocument ?? buildDemoOpenApiSpec(this.baseUrl);
    const openApiIndex = OpenApiIndex.fromRawDocument(openApiDoc);

    const parsedBase = new URL(this.baseUrl);
    const defaultPort = Number(parsedBase.port || (parsedBase.protocol === "https:" ? 443 : 80));
    const allowedHosts = request.allowedHosts?.length
      ? request.allowedHosts
      : [parsedBase.hostname, "127.0.0.1", "localhost"];
    const allowedPorts = request.allowedPorts?.length
      ? request.allowedPorts
      : [...new Set([defaultPort, 80, 443, 3000, 8080])];

    let modelConfig;
    let reviewerStreamFn;
    if (mode === "live") {
      modelConfig = resolveLiveModel();
    } else {
      const mock = createDemoMockStream({
        baseUrl: this.baseUrl,
        scenario: request.mockScenario ?? "orders-debug"
      });
      modelConfig = { model: MOCK_MODEL, streamFn: mock.leadStreamFn };
      reviewerStreamFn = mock.reviewerStreamFn;
    }

    const registry = new ToolRegistry();
    for (const tool of createOpenApiTools(() => openApiIndex)) registry.register(tool);
    for (const tool of createHttpTools({
      allowedHosts,
      allowedPorts,
      ...(request.requireApprovalForMutations !== undefined
        ? { requireApprovalForMutations: request.requireApprovalForMutations }
        : {})
    })) {
      registry.register(tool);
    }
    for (const tool of createCoreHarnessTools({
      skills: this.skills,
      registry,
      subagentRuntime: modelConfig
    })) {
      registry.register(tool);
    }

    return new AgentHarnessRuntime({
      model: modelConfig.model,
      streamFn: modelConfig.streamFn,
      ...(modelConfig.apiKey ? { apiKey: modelConfig.apiKey } : {}),
      ...(reviewerStreamFn ? { reviewerStreamFn } : {}),
      store: this.store,
      registry,
      skills: this.skills,
      enableReviewer: request.enableReviewer ?? true
    });
  }

  async startRun(request: CreateRunRequest): Promise<{ runId: string; status: string }> {
    const runId = `run_${randomUUID().slice(0, 12)}`;
    const runtime = this.buildRuntime(request);
    const controller = new AbortController();
    const listeners = new Set<HarnessEventListener>();

    this.activeRuns.set(runId, { runtime, controller, listeners });
    this.runRuntimes.set(runId, runtime);

    // 异步后台驱动，立刻返回 runId 供前端建立 SSE 连接
    void runtime
      .start(
        {
          id: runId,
          title: request.title?.trim() || "API Diagnostic Session",
          goal: request.goal,
          kind: request.kind ?? "api-debug",
          environment: request.environment ?? "sandbox",
          metadata: { mode: request.mode ?? (process.env.DEEPSEEK_API_KEY ? "live" : "mock") }
        },
        {
          signal: controller.signal,
          onEvent: (event) => this.broadcast(runId, event)
        }
      )
      .finally(() => {
        this.activeRuns.delete(runId);
      });

    return { runId, status: "running" };
  }

  async decideApproval(params: {
    runId: string;
    approvalId: string;
    decision: "approved" | "denied";
    decidedBy: string;
    note?: string;
  }): Promise<RunSnapshot> {
    let runtime = this.runRuntimes.get(params.runId);
    if (!runtime) {
      const existing = await this.store.loadSnapshot(params.runId);
      if (!existing) throw new Error(`Run "${params.runId}" not found`);
      const mode = (existing.task.metadata?.mode as "live" | "mock" | undefined) ?? "mock";
      runtime = this.buildRuntime({
        goal: existing.task.goal,
        kind: existing.task.kind,
        environment: existing.task.environment,
        mode
      });
      this.runRuntimes.set(params.runId, runtime);
    }

    const controller = new AbortController();
    const listeners = this.activeRuns.get(params.runId)?.listeners ?? new Set<HarnessEventListener>();
    this.activeRuns.set(params.runId, { runtime, controller, listeners });

    try {
      return await runtime.decideApprovalAndResume({
        runId: params.runId,
        approvalId: params.approvalId,
        decision: params.decision,
        decidedBy: params.decidedBy,
        ...(params.note ? { note: params.note } : {}),
        signal: controller.signal,
        onEvent: (event) => this.broadcast(params.runId, event)
      });
    } finally {
      this.activeRuns.delete(params.runId);
    }
  }

  cancelRun(runId: string): boolean {
    const entry = this.activeRuns.get(runId);
    if (!entry) return false;
    entry.controller.abort("USER_CANCELLED");
    return true;
  }
}
