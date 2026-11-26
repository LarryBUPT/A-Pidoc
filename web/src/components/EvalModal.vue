<script setup lang="ts">
import type { EvaluationReport } from "../types";

defineProps<{
  open: boolean;
  report: EvaluationReport | null;
  running: boolean;
  liveConfigured: boolean;
}>();

const emit = defineEmits<{
  close: [];
  run: [mode: "offline" | "live"];
}>();
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card">
      <div class="drawer-header">
        <div>
          <strong style="font-size: 15px">评测中心 · Raw Pi Agent vs A-Pidoc Harness</strong>
          <div v-if="report" style="font-size: 11.5px; color: var(--text-muted)">
            模式：{{ report.mode }} · 模型：{{ report.modelId }} · 生成于 {{ new Date(report.generatedAt).toLocaleString() }}
          </div>
        </div>
        <div style="display: flex; gap: 8px">
          <button class="btn primary" :disabled="running" @click="emit('run', 'offline')">
            {{ running ? "运行中..." : "重跑离线基准" }}
          </button>
          <button class="btn" :disabled="running || !liveConfigured" @click="emit('run', 'live')">
            DeepSeek Live 实测
          </button>
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </div>

      <div class="drawer-body" v-if="report">
        <div class="metrics-grid" style="grid-template-columns: repeat(4, 1fr)">
          <div class="metric-tile">
            <div class="metric-label">任务通过率 (Raw → Harness)</div>
            <div class="metric-val">
              <span style="color: var(--danger)">{{ report.rawSummary.passRate }}%</span> →
              <span style="color: var(--success)">{{ report.harnessSummary.passRate }}%</span>
            </div>
          </div>
          <div class="metric-tile">
            <div class="metric-label">安全护栏率 (Raw → Harness)</div>
            <div class="metric-val">
              <span style="color: var(--warn)">{{ report.rawSummary.safetyRate }}%</span> →
              <span style="color: var(--success)">{{ report.harnessSummary.safetyRate }}%</span>
            </div>
          </div>
          <div class="metric-tile">
            <div class="metric-label">幻觉误报率 (Raw → Harness)</div>
            <div class="metric-val">
              <span style="color: var(--danger)">{{ report.rawSummary.hallucinationRate }}%</span> →
              <span style="color: var(--success)">{{ report.harnessSummary.hallucinationRate }}%</span>
            </div>
          </div>
          <div class="metric-tile">
            <div class="metric-label">Harness 平均耗时 / 总 Token</div>
            <div class="metric-val">
              {{ report.harnessSummary.avgDurationMs }}ms
              <span style="font-size: 11px; color: var(--text-muted)">({{ report.harnessSummary.totalTokens }}t)</span>
            </div>
          </div>
        </div>

        <table class="eval-table">
          <thead>
            <tr>
              <th>评测场景</th>
              <th>维度</th>
              <th>Raw Pi Agent</th>
              <th>A-Pidoc Harness</th>
              <th>证据 / 压缩</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.scenarios" :key="row.id">
              <td><strong>{{ row.name }}</strong></td>
              <td><span class="badge info">{{ row.category }}</span></td>
              <td>
                <span class="badge" :class="row.rawOutcome.passed ? 'ok' : 'danger'">{{ row.rawOutcome.status }}</span>
                <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px">{{ row.rawOutcome.note }}</div>
              </td>
              <td>
                <span class="badge" :class="row.harnessOutcome.passed ? 'ok' : 'danger'">{{ row.harnessOutcome.status }}</span>
                <div style="font-size: 11.5px; color: var(--text-muted); margin-top: 4px">{{ row.harnessOutcome.note }}</div>
              </td>
              <td style="font-family: var(--mono); font-size: 11.5px">
                Ev: {{ row.harnessOutcome.evidenceCount }}<br />
                Cmp: {{ row.harnessOutcome.compactions }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
