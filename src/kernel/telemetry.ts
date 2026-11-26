import { randomUUID } from "node:crypto";
import { redactValue } from "../shared/redaction.js";
import type { HarnessEvent, RunMetrics, TraceSpan, TraceSpanKind } from "./types.js";

export type HarnessEventListener = (event: HarnessEvent) => void;

/**
 * 四层可观测性核心：
 * 1. Structured Tracing（嵌套 Span 树）
 * 2. Metrics（Token / 成本 / TTFT / 工具失败率 / 压缩次数）
 * 3. Trajectory Events（结构化时序事件，供 JSONL 持久化与回放）
 * 4. Live Telemetry Stream（实时推送给 Hono SSE / Vue 前端）
 */
export class TelemetryCollector {
  private sequence = 0;
  private readonly listeners = new Set<HarnessEventListener>();
  private readonly openSpans = new Map<string, { span: TraceSpan; startedAtMs: number }>();

  constructor(
    readonly runId: string,
    readonly spans: TraceSpan[],
    readonly metrics: RunMetrics,
    private readonly onPersistEvent?: (event: HarnessEvent) => Promise<void> | void
  ) {}

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(type: HarnessEvent["type"], payload: Record<string, unknown>): HarnessEvent {
    this.sequence += 1;
    const event: HarnessEvent = {
      seq: this.sequence,
      runId: this.runId,
      at: new Date().toISOString(),
      type,
      payload: redactValue(payload) as Record<string, unknown>
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅端（如断开的 SSE 连接）异常不影响主执行链
      }
    }

    if (this.onPersistEvent) {
      void Promise.resolve(this.onPersistEvent(event)).catch(() => {});
    }

    return event;
  }

  startSpan(
    kind: TraceSpanKind,
    name: string,
    attributes: Record<string, unknown> = {},
    parentSpanId?: string
  ): TraceSpan {
    const span: TraceSpan = {
      spanId: `sp_${randomUUID().slice(0, 12)}`,
      ...(parentSpanId ? { parentSpanId } : {}),
      kind,
      name,
      startedAt: new Date().toISOString(),
      status: "running",
      attributes: redactValue(attributes) as Record<string, unknown>
    };
    this.spans.push(span);
    this.openSpans.set(span.spanId, { span, startedAtMs: Date.now() });
    return span;
  }

  endSpan(
    spanId: string,
    status: "ok" | "error" | "blocked",
    extraAttributes: Record<string, unknown> = {}
  ): TraceSpan | undefined {
    const record = this.openSpans.get(spanId);
    if (!record) return undefined;

    this.openSpans.delete(spanId);
    const endedAtMs = Date.now();
    record.span.endedAt = new Date(endedAtMs).toISOString();
    record.span.durationMs = Math.max(0, endedAtMs - record.startedAtMs);
    record.span.status = status;
    record.span.attributes = {
      ...record.span.attributes,
      ...(redactValue(extraAttributes) as Record<string, unknown>)
    };
    return record.span;
  }

  async withSpan<T>(
    kind: TraceSpanKind,
    name: string,
    attributes: Record<string, unknown>,
    fn: (span: TraceSpan) => Promise<T>,
    parentSpanId?: string
  ): Promise<T> {
    const span = this.startSpan(kind, name, attributes, parentSpanId);
    try {
      const output = await fn(span);
      this.endSpan(span.spanId, "ok");
      return output;
    } catch (error) {
      this.endSpan(span.spanId, "error", {
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  recordModelUsage(usage: {
    input?: number;
    output?: number;
    totalTokens?: number;
    costUsd?: number;
    ttftMs?: number;
  }): void {
    this.metrics.inputTokens += usage.input ?? 0;
    this.metrics.outputTokens += usage.output ?? 0;
    this.metrics.totalTokens += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0);
    this.metrics.estimatedCostUsd = Number(
      (this.metrics.estimatedCostUsd + (usage.costUsd ?? 0)).toFixed(6)
    );
    if (this.metrics.ttftMs === null && typeof usage.ttftMs === "number") {
      this.metrics.ttftMs = usage.ttftMs;
    }
  }
}
