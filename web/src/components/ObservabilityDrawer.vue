<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { HarnessEvent, RunSnapshot } from "../types";

const props = defineProps<{
  open: boolean;
  snapshot: RunSnapshot | null;
  events: HarnessEvent[];
}>();

const emit = defineEmits<{
  close: [];
}>();

const replayIndex = ref(0);

watch(
  () => props.events.length,
  (len) => {
    replayIndex.value = Math.max(0, len - 1);
  },
  { immediate: true }
);

const timeBounds = computed(() => {
  const spans = props.snapshot?.spans ?? [];
  if (!spans.length) return { startMs: 0, totalMs: 1 };
  const starts = spans.map((s) => Date.parse(s.startedAt)).filter((n) => Number.isFinite(n));
  const ends = spans
    .map((s) => (s.endedAt ? Date.parse(s.endedAt) : Date.parse(s.startedAt) + (s.durationMs ?? 1)))
    .filter((n) => Number.isFinite(n));
  const startMs = Math.min(...starts);
  const endMs = Math.max(...ends, startMs + 1);
  return { startMs, totalMs: Math.max(1, endMs - startMs) };
});

function spanBarStyle(span: { startedAt: string; durationMs?: number; endedAt?: string }) {
  const { startMs, totalMs } = timeBounds.value;
  const s = Date.parse(span.startedAt);
  const offset = Number.isFinite(s) ? Math.max(0, s - startMs) : 0;
  const dur = Math.max(1, span.durationMs ?? (span.endedAt ? Date.parse(span.endedAt) - s : 1));
  const left = Math.min(96, (offset / totalMs) * 100);
  const width = Math.max(3, Math.min(100 - left, (dur / totalMs) * 100));
  return { left: `${left}%`, width: `${width}%` };
}

const activeReplayEvent = computed(() => props.events[replayIndex.value] ?? null);

function badgeClass(status: string): string {
  if (status === "ok" || status === "resolved") return "ok";
  if (status === "blocked" || status === "running") return "warn";
  if (status === "error" || status === "failed") return "danger";
  return "info";
}
</script>

<template>
  <div v-if="open" class="drawer-backdrop" @click.self="emit('close')">
    <aside class="drawer-panel">
      <div class="drawer-header">
        <div>
          <strong style="font-size: 15px">开发者观测面板 (Observability)</strong>
          <div style="font-size: 11.5px; color: var(--text-muted)">
            四层可观测：定量指标 · 嵌套 Span 瀑布 · Context 压缩 · 逐步回放
          </div>
        </div>
        <button class="btn" @click="emit('close')">收起</button>
      </div>

      <div class="drawer-body">
        <div v-if="!snapshot" style="text-align: center; padding: 48px 16px; color: var(--text-muted); font-size: 13px">
          请先发起或选中一条诊断会话，即可在此查看 Trace、指标与逐帧回放。
        </div>

        <template v-else>
          <div class="section-subtitle" style="margin-top: 0">1. 运行定量指标 (Metrics)</div>
          <div class="metrics-grid">
            <div class="metric-tile">
              <div class="metric-label">总耗时 Duration</div>
              <div class="metric-val">{{ snapshot.metrics.durationMs }}ms</div>
            </div>
            <div class="metric-tile">
              <div class="metric-label">首字延迟 TTFT</div>
              <div class="metric-val">{{ snapshot.metrics.ttftMs ?? "-" }}ms</div>
            </div>
            <div class="metric-tile">
              <div class="metric-label">Tokens / 成本</div>
              <div class="metric-val">
                {{ snapshot.metrics.totalTokens }}
                <span style="font-size: 11px; color: var(--text-muted)">${{ snapshot.metrics.estimatedCostUsd }}</span>
              </div>
            </div>
            <div class="metric-tile">
              <div class="metric-label">工具调用 / 失败</div>
              <div class="metric-val">{{ snapshot.metrics.toolCalls }} / {{ snapshot.metrics.failedToolCalls }}</div>
            </div>
            <div class="metric-tile">
              <div class="metric-label">Context 压缩</div>
              <div class="metric-val">{{ snapshot.metrics.compactionCount }}</div>
            </div>
            <div class="metric-tile">
              <div class="metric-label">Multi-Agent 协同</div>
              <div class="metric-val">{{ snapshot.metrics.subagentCalls }}</div>
            </div>
          </div>

          <div class="section-subtitle">2. 嵌套 Span 耗时瀑布 ({{ snapshot.spans.length }})</div>
          <div style="border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin-bottom: 18px">
            <div v-for="span in snapshot.spans" :key="span.spanId" class="span-row">
              <div style="font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                <span v-if="span.parentSpanId" style="color: var(--text-muted)">└ </span>{{ span.name }}
              </div>
              <div>
                <span class="badge" :class="badgeClass(span.status)">{{ span.kind }}</span>
              </div>
              <div class="span-track" style="position: relative">
                <div class="span-fill" style="position: absolute; top: 0" :style="spanBarStyle(span)"></div>
              </div>
              <div style="text-align: right; font-family: var(--mono); color: var(--text-muted)">
                {{ span.durationMs ?? 0 }}ms
              </div>
            </div>
          </div>

          <div class="section-subtitle">3. 逐步轨迹回放器 (Trajectory Replay)</div>
          <div style="border: 1px solid var(--border); border-radius: 10px; padding: 12px">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px">
              <span style="font-size: 12px; font-family: var(--mono); color: var(--text-secondary)">
                Step {{ events.length ? replayIndex + 1 : 0 }} / {{ events.length }}
              </span>
              <div style="display: flex; gap: 6px">
                <button class="btn" style="padding: 4px 10px" :disabled="replayIndex <= 0" @click="replayIndex--">
                  上一步
                </button>
                <button
                  class="btn"
                  style="padding: 4px 10px"
                  :disabled="replayIndex >= events.length - 1"
                  @click="replayIndex++"
                >
                  下一步
                </button>
              </div>
            </div>
            <input
              type="range"
              min="0"
              :max="Math.max(0, events.length - 1)"
              v-model.number="replayIndex"
              style="width: 100%; margin-bottom: 10px"
            />
            <div style="min-height: 274px">
              <template v-if="activeReplayEvent">
                <div style="display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 6px; height: 20px">
                  <strong style="font-family: var(--mono); color: var(--accent)">
                    #{{ activeReplayEvent.seq }} · {{ activeReplayEvent.type }}
                  </strong>
                  <span style="color: var(--text-muted)">{{ new Date(activeReplayEvent.at).toLocaleTimeString() }}</span>
                </div>
                <pre class="code-block replay-code-fixed">{{ JSON.stringify(activeReplayEvent.payload, null, 2) }}</pre>
              </template>
              <div v-else class="code-block replay-code-fixed" style="color: var(--text-muted)">
                暂无可回放事件
              </div>
            </div>
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>
