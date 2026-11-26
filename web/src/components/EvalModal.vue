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

function attributionLabel(code?: string): string {
  if (code === "agent_pipeline") return "Agent 链路缺陷";
  if (code === "model_capability") return "模型能力瓶颈";
  if (code === "rubric_or_dataset") return "标准/数据待校准";
  return "无";
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-card" style="width: min(1060px, 96vw)">
      <div class="drawer-header">
        <div>
          <strong style="font-size: 15px">评测中心 · 三组消融实验与四维 Rubrics 归因</strong>
          <div v-if="report" style="font-size: 11.5px; color: var(--text-muted)">
            模式：{{ report.mode }} · 模型：{{ report.modelId }} · 微服务靶场：{{ report.endpointCount ?? 32 }} 端点 ·
            {{ report.rubricFormula ?? "A*0.4 + B*0.4 + C*0.2 >= 80 (D 一票否决)" }}
          </div>
        </div>
        <div style="display: flex; gap: 8px">
          <button class="btn primary" :disabled="running" @click="emit('run', 'offline')">
            {{ running ? "运行中..." : "重跑 12 题离线消融" }}
          </button>
          <button class="btn" :disabled="running || !liveConfigured" @click="emit('run', 'live')">
            DeepSeek Live 消融实测
          </button>
          <button class="btn" @click="emit('close')">关闭</button>
        </div>
      </div>

      <div class="drawer-body" v-if="report">
        <!-- 三组消融核心指标梯度卡（V0 裸基线 -> V1 +上下文工程 -> V2 完整 Harness） -->
        <div v-if="report.ablation" class="metrics-grid" style="grid-template-columns: repeat(3, 1fr)">
          <div
            v-for="group in [report.ablation.V0_raw, report.ablation.V1_context, report.ablation.V2_harness]"
            :key="group.variant"
            class="metric-tile"
          >
            <div class="metric-label">{{ group.label }}</div>
            <div class="metric-val" style="margin: 6px 0">
              通过率
              <span :style="{ color: group.passRate >= 90 ? 'var(--success)' : group.passRate >= 50 ? 'var(--warn)' : 'var(--danger)' }">
                {{ group.passRate }}%
              </span>
              <span style="font-size: 12px; color: var(--text-muted)">
                ({{ group.passedCases }}/{{ group.totalCases }})
              </span>
            </div>
            <div style="font-size: 11.5px; color: var(--text-secondary); display: flex; flex-direction: column; gap: 2px">
              <span>Rubrics 加权均分：<strong>{{ group.avgWeightedScore }}</strong>（A:{{ group.avgProcessScore }} / B:{{ group.avgResultScore }} / C:{{ group.avgExpressionScore }}）</span>
              <span>风险一票否决率：<strong>{{ group.riskVetoRate }}%</strong> · 幻觉率：{{ group.hallucinationRate }}%</span>
              <span>性能：E2E {{ group.avgDurationMs }}ms · TTFT {{ group.avgTtftMs ?? "-" }}ms · {{ group.totalTokens }} tok</span>
              <span>
                Badcase 归因：链路 {{ group.badcaseAttribution.agent_pipeline }} · 模型 {{ group.badcaseAttribution.model_capability }} · 标准 {{ group.badcaseAttribution.rubric_or_dataset }}
              </span>
            </div>
          </div>
        </div>

        <table class="eval-table">
          <thead>
            <tr>
              <th>评测用例（正/负/边界/对抗）</th>
              <th>V0 裸基线</th>
              <th>V1 +上下文工程</th>
              <th>V2 完整 Harness（A/B/C 分）</th>
              <th>Badcase 归因 (V0 → V2)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in report.scenarios" :key="row.id">
              <td>
                <strong>{{ row.name }}</strong>
                <div style="margin-top: 3px"><span class="badge info">{{ row.category }}</span></div>
              </td>
              <td>
                <span class="badge" :class="row.rawOutcome.passed ? 'ok' : 'danger'">
                  {{ row.rawOutcome.passed ? "PASS" : "FAIL" }} · {{ row.rawOutcome.weightedScore ?? "-" }}分
                </span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">{{ row.rawOutcome.note }}</div>
              </td>
              <td v-if="row.v1ContextOutcome">
                <span class="badge" :class="row.v1ContextOutcome.passed ? 'ok' : 'warn'">
                  {{ row.v1ContextOutcome.passed ? "PASS" : "FAIL" }} · {{ row.v1ContextOutcome.weightedScore ?? "-" }}分
                </span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">{{ row.v1ContextOutcome.note }}</div>
              </td>
              <td v-else>-</td>
              <td>
                <span class="badge" :class="row.harnessOutcome.passed ? 'ok' : 'danger'">
                  {{ row.harnessOutcome.passed ? "PASS" : "FAIL" }} · {{ row.harnessOutcome.weightedScore ?? "-" }}分
                </span>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px">
                  A:{{ row.harnessOutcome.processScore }} / B:{{ row.harnessOutcome.resultScore }} / C:{{ row.harnessOutcome.expressionScore }} · Ev:{{ row.harnessOutcome.evidenceCount }}
                </div>
              </td>
              <td style="font-size: 11.5px; color: var(--text-secondary)">
                <div>V0: {{ attributionLabel(row.rawOutcome.attribution) }}</div>
                <div>V2: {{ attributionLabel(row.harnessOutcome.attribution) }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
