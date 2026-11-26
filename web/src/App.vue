<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import EvalModal from "./components/EvalModal.vue";
import ObservabilityDrawer from "./components/ObservabilityDrawer.vue";
import type { EvaluationReport, EvidenceArtifact, HarnessEvent, RunSnapshot, RunSummary } from "./types";

type MainView = "chat" | "trace";
type InputMode = "natural" | "curl" | "openapi";

const THEME_STORAGE_KEY = "a-pidoc-theme";
const savedTheme = typeof window !== "undefined" ? window.localStorage.getItem(THEME_STORAGE_KEY) : null;
const theme = ref<"dark" | "light">(savedTheme === "dark" ? "dark" : "light");
const mainView = ref<MainView>("chat");
const inputMode = ref<InputMode>("natural");
const drawerOpen = ref(false);
const evalOpen = ref(false);
const thinkingExpanded = ref(false);
const traceFilter = ref("");
const expandedTraceSeq = ref<number | null>(null);
const inspectedEvidence = ref<EvidenceArtifact | null>(null);

const health = ref<{
  version: string;
  engine: string;
  baseUrl: string;
  liveConfigured: boolean;
  defaultModel: string;
  skills: Array<{ name: string; description: string }>;
} | null>(null);

const presets = ref<
  Array<{ id: string; title: string; kind: string; mockScenario: "orders-debug" | "payment-approval"; goal: string }>
>([]);

// 输入状态
const promptInput = ref("");
const curlInput = ref("");
const openApiText = ref("");
const runMode = ref<"mock" | "live">("mock");
const mockScenario = ref<"orders-debug" | "payment-approval">("orders-debug");
const enableReviewer = ref(true);

// 会话与实时流
const runs = ref<RunSummary[]>([]);
const historyFilter = ref<"active" | "archived">("active");
const currentRunId = ref<string | null>(null);
const currentSnapshot = ref<RunSnapshot | null>(null);
const events = ref<HarnessEvent[]>([]);
const streaming = ref(false);
const approvalNote = ref("已在工作台核对请求参数与沙箱环境");
const approvalBusy = ref(false);

const defaultPlaceholderGoal = computed(() => {
  const base = health.value?.baseUrl || "http://127.0.0.1:3000";
  return `排查 POST ${base}/sandbox/orders 返回 415/400 的原因并验证修复`;
});

const activeRuns = computed(() => runs.value.filter((item) => !item.archived));
const archivedRuns = computed(() => runs.value.filter((item) => item.archived));
const visibleRuns = computed(() => (historyFilter.value === "active" ? activeRuns.value : archivedRuns.value));

// 评测
const evalReport = ref<EvaluationReport | null>(null);
const evalRunning = ref(false);

let activeEventSource: EventSource | null = null;

function applyTheme(next: "dark" | "light") {
  theme.value = next;
  document.documentElement.setAttribute("data-theme", next);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 忽略无痕模式存储限制
  }
}

function toggleTheme() {
  applyTheme(theme.value === "dark" ? "light" : "dark");
}

const pendingApproval = computed(
  () => currentSnapshot.value?.approvals.find((item) => item.status === "pending") ?? null
);

const stepHighlights = computed(() =>
  events.value
    .filter((ev) =>
      [
        "tool_started",
        "evidence_recorded",
        "context_compacted",
        "approval_required",
        "approval_decided",
        "subagent_started",
        "gate_evaluated",
        "reviewer_verdict"
      ].includes(ev.type)
    )
    .map((ev) => {
      if (ev.type === "tool_started") return `调用工具 ${String(ev.payload.toolName)}`;
      if (ev.type === "evidence_recorded") return `采集证据 ${String(ev.payload.summary ?? ev.payload.id)}`;
      if (ev.type === "context_compacted") return "触发上下文压缩（释放早期冗余消息）";
      if (ev.type === "approval_required") return `写操作 ${String(ev.payload.toolName)} 挂起等待人工审批`;
      if (ev.type === "approval_decided") return `人工审批：${String(ev.payload.decision)}`;
      if (ev.type === "subagent_started") return `启动子 Agent (${String(ev.payload.role)})`;
      if (ev.type === "gate_evaluated") return `EvidenceGate 硬门禁：${ev.payload.passed ? "通过" : "未通过"}`;
      if (ev.type === "reviewer_verdict") return `独立 Reviewer 复核：${String(ev.payload.verdict).toUpperCase()}`;
      return ev.type;
    })
);

const latestAssistantText = computed(() => {
  const msgs = events.value.filter((ev) => ev.type === "assistant_message" && ev.payload.text);
  return String(msgs.at(-1)?.payload.text ?? "");
});

// DSH 紧凑单行轨迹视图模型
interface CompactTraceItem {
  seq: number;
  tagLabel: string;
  tagClass: "sys" | "user" | "ctx" | "ast" | "tool";
  lane: "input" | "model" | "tool";
  preview: string;
  event: HarnessEvent;
}

const compactTraceItems = computed<CompactTraceItem[]>(() => {
  const query = traceFilter.value.trim().toLowerCase();
  const list: CompactTraceItem[] = [];

  // 补齐 0ms 锚点：若历史事件未含 run_started，用 snapshot.task 补齐首条用户输入，避免开头空白
  const hasStartEvent = events.value.some((ev) => ev.type === "run_started");
  if (!hasStartEvent && currentSnapshot.value) {
    const goal = currentSnapshot.value.task.goal;
    if (!query || goal.toLowerCase().includes(query) || "用户".includes(query)) {
      list.push({
        seq: 0,
        tagLabel: "用户",
        tagClass: "user",
        lane: "input",
        preview: goal,
        event: {
          seq: 0,
          runId: currentSnapshot.value.runId,
          at: currentSnapshot.value.createdAt,
          type: "run_started",
          payload: { task: currentSnapshot.value.task }
        }
      });
    }
  }

  for (const ev of events.value) {
    if (ev.type === "assistant_delta" || ev.type === "turn_started") continue;
    let tagLabel = "系统";
    let tagClass: CompactTraceItem["tagClass"] = "sys";
    let lane: CompactTraceItem["lane"] = "input";
    let preview = "";

    if (ev.type === "run_started") {
      tagLabel = "用户";
      tagClass = "user";
      lane = "input";
      const task = ev.payload.task as { goal?: string } | undefined;
      preview = task?.goal ?? "启动诊断任务";
    } else if (ev.type === "assistant_message") {
      tagLabel = "助手";
      tagClass = "ast";
      lane = "model";
      preview = String(ev.payload.text || `[stopReason=${String(ev.payload.stopReason)}]`);
    } else if (ev.type === "tool_started") {
      tagLabel = "工具";
      tagClass = "tool";
      lane = "tool";
      preview = `${String(ev.payload.toolName)} ${JSON.stringify(ev.payload.args ?? {})}`;
    } else if (ev.type === "tool_finished") {
      tagLabel = "工具";
      tagClass = "tool";
      lane = "tool";
      const details = ev.payload.details as { summary?: string } | undefined;
      preview = `${String(ev.payload.toolName)} → ${details?.summary ?? (ev.payload.isError ? "ERROR" : "OK")}`;
    } else if (ev.type === "evidence_recorded" || ev.type === "context_compacted") {
      tagLabel = "上下文";
      tagClass = "ctx";
      lane = "input";
      preview =
        ev.type === "context_compacted"
          ? `Compaction ${String(ev.payload.beforeBytes)}B → ${String(ev.payload.afterBytes)}B`
          : `[${String(ev.payload.id)}] ${String(ev.payload.summary ?? "")}`;
    } else if (ev.type === "approval_required" || ev.type === "approval_decided") {
      tagLabel = "审批";
      tagClass = "tool";
      lane = "tool";
      preview = `${ev.type}: ${String(ev.payload.toolName ?? "")} ${String(ev.payload.decision ?? ev.payload.approvalId ?? "")}`;
    } else if (ev.type === "gate_evaluated" || ev.type === "reviewer_verdict" || ev.type === "subagent_started") {
      tagLabel = "核验";
      tagClass = "ctx";
      lane = "model";
      preview = `${ev.type}: ${JSON.stringify(ev.payload)}`;
    } else {
      preview = `${ev.type}: ${JSON.stringify(ev.payload)}`;
    }

    if (!query || preview.toLowerCase().includes(query) || tagLabel.includes(query)) {
      list.push({ seq: ev.seq, tagLabel, tagClass, lane, preview, event: ev });
    }
  }
  return list;
});

interface TimelineSegment {
  id: string;
  lane: "input" | "model" | "tool";
  label: string;
  color: string;
  leftPct: number;
  widthPct: number;
  durationMs: number;
  targetSeq?: number;
}

const timelineData = computed(() => {
  const spans = currentSnapshot.value?.spans ?? [];
  const evs = events.value;

  const timestamps: number[] = [];
  for (const s of spans) {
    const t0 = Date.parse(s.startedAt);
    if (Number.isFinite(t0)) timestamps.push(t0);
    const t1 = s.endedAt ? Date.parse(s.endedAt) : t0 + (s.durationMs ?? 1);
    if (Number.isFinite(t1)) timestamps.push(t1);
  }
  for (const e of evs) {
    const t = Date.parse(e.at);
    if (Number.isFinite(t)) timestamps.push(t);
  }

  if (!timestamps.length) {
    return { totalMs: 0, segments: { input: [] as TimelineSegment[], model: [] as TimelineSegment[], tool: [] as TimelineSegment[] } };
  }

  const minMs = Math.min(...timestamps);
  const maxMs = Math.max(...timestamps, minMs + 1);
  const totalMs = Math.max(1, maxMs - minMs);

  const input: TimelineSegment[] = [];
  const model: TimelineSegment[] = [];
  const tool: TimelineSegment[] = [];

  const place = (startMs: number, durMs: number) => {
    const leftPct = Math.max(0, Math.min(97, ((startMs - minMs) / totalMs) * 100));
    const rawWidth = (Math.max(1, durMs) / totalMs) * 100;
    const widthPct = Math.max(1.8, Math.min(100 - leftPct, rawWidth));
    return { leftPct, widthPct };
  };

  // 1. 模型与工具泳道直接取真实 Span 起始时间与持续时长，真实错落排列
  for (const span of spans) {
    if (span.kind === "run") continue;
    const startMs = Date.parse(span.startedAt);
    const durMs = Math.max(1, span.durationMs ?? 1);
    const { leftPct, widthPct } = place(startMs, durMs);

    if (span.kind === "llm_call" || span.kind === "subagent_reviewer" || span.kind === "subagent_specialist") {
      model.push({
        id: span.spanId,
        lane: "model",
        label: `${span.name} (${durMs}ms)`,
        color: span.kind === "llm_call" ? "#a855f7" : "#38bdf8",
        leftPct,
        widthPct,
        durationMs: durMs
      });
    } else if (span.kind === "tool_call" || span.kind === "approval_wait") {
      tool.push({
        id: span.spanId,
        lane: "tool",
        label: `${span.name} (${durMs}ms)`,
        color: span.kind === "approval_wait" ? "#ef4444" : "#f59e0b",
        leftPct,
        widthPct,
        durationMs: durMs
      });
    } else if (span.kind === "compaction" || span.kind === "evidence_gate") {
      input.push({
        id: span.spanId,
        lane: "input",
        label: `${span.name} (${durMs}ms)`,
        color: "#22c55e",
        leftPct,
        widthPct,
        durationMs: durMs
      });
    }
  }

  // 2. 输入/上下文事件（用户首条输入、证据入板）按真实时间戳落入输入泳道
  const hasStart = evs.some((e) => e.type === "run_started");
  if (!hasStart && currentSnapshot.value) {
    input.push({
      id: "ev_start_anchor",
      lane: "input",
      label: "用户输入与初始化",
      color: "#60a5fa",
      leftPct: 0,
      widthPct: 5,
      durationMs: 1,
      targetSeq: 0
    });
  }
  for (const ev of evs) {
    if (!["run_started", "evidence_recorded", "approval_decided"].includes(ev.type)) continue;
    const t = Date.parse(ev.at);
    const { leftPct, widthPct } = place(t, Math.max(1, totalMs * 0.04));
    input.push({
      id: `ev_${ev.seq}`,
      lane: "input",
      label: `#${ev.seq} ${ev.type}`,
      color: ev.type === "run_started" ? "#60a5fa" : "#4ade80",
      leftPct,
      widthPct,
      durationMs: 1,
      targetSeq: ev.seq
    });
  }

  return { totalMs, segments: { input, model, tool } };
});

async function loadBootstrap() {
  applyTheme(theme.value);
  const [healthRes, presetsRes, runsRes, evalRes] = await Promise.all([
    fetch("/api/health").then((r) => r.json()),
    fetch("/api/demo/presets").then((r) => r.json()),
    fetch("/api/runs").then((r) => r.json()),
    fetch("/api/eval/latest").then((r) => r.json()).catch(() => null)
  ]);

  health.value = healthRes;
  presets.value = presetsRes.presets ?? [];
  openApiText.value = JSON.stringify(presetsRes.openApiDocument, null, 2);
  runs.value = runsRes.runs ?? [];
  if (evalRes) evalReport.value = evalRes;

  const base = healthRes.baseUrl || "http://127.0.0.1:3000";
  curlInput.value = `curl -X POST ${base}/sandbox/orders \\\n  -H "Content-Type: text/plain" \\\n  -d '{"sku":"SKU-100","amount":"99","currency":"CNY"}'`;
}

function startNewChat() {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  streaming.value = false;
  currentRunId.value = null;
  currentSnapshot.value = null;
  events.value = [];
  mainView.value = "chat";
  thinkingExpanded.value = false;
}

async function refreshRuns() {
  const data = await fetch("/api/runs").then((r) => r.json());
  runs.value = data.runs ?? [];
}

async function selectRun(runId: string) {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  currentRunId.value = runId;
  thinkingExpanded.value = false;
  expandedTraceSeq.value = null;

  const [snapRes, evRes] = await Promise.all([
    fetch(`/api/runs/${runId}`).then((r) => r.json()),
    fetch(`/api/runs/${runId}/events`).then((r) => r.json())
  ]);

  currentSnapshot.value = snapRes.snapshot;
  events.value = evRes.events ?? [];
  if (snapRes.active) {
    attachStream(runId);
  }
}

function attachStream(runId: string) {
  if (activeEventSource) activeEventSource.close();
  streaming.value = true;

  const es = new EventSource(`/api/runs/${runId}/stream`);
  activeEventSource = es;

  const eventTypes = [
    "run_started",
    "turn_started",
    "assistant_message",
    "tool_started",
    "tool_finished",
    "evidence_recorded",
    "context_compacted",
    "approval_required",
    "approval_decided",
    "subagent_started",
    "subagent_finished",
    "gate_evaluated",
    "reviewer_verdict",
    "run_finished"
  ];

  for (const type of eventTypes) {
    es.addEventListener(type, (raw) => {
      const parsed = JSON.parse((raw as MessageEvent).data) as HarnessEvent;
      if (!events.value.some((e) => e.seq === parsed.seq)) {
        events.value.push(parsed);
      }
      if (["approval_required", "run_finished", "evidence_recorded", "reviewer_verdict"].includes(type)) {
        void fetch(`/api/runs/${runId}`)
          .then((r) => r.json())
          .then((res) => {
            currentSnapshot.value = res.snapshot;
          });
        void refreshRuns();
      }
      if (type === "run_finished") {
        streaming.value = false;
        es.close();
        activeEventSource = null;
      }
    });
  }

  es.addEventListener("stream_closed", () => {
    streaming.value = false;
    es.close();
    activeEventSource = null;
  });

  es.onerror = () => {
    streaming.value = false;
    es.close();
    activeEventSource = null;
  };
}

async function launchRun(payload: {
  title: string;
  goal: string;
  scenario?: "orders-debug" | "payment-approval";
}) {
  events.value = [];
  currentSnapshot.value = null;
  mainView.value = "chat";
  thinkingExpanded.value = false;
  expandedTraceSeq.value = null;

  let parsedOpenApi: unknown = undefined;
  if (openApiText.value.trim()) {
    try {
      parsedOpenApi = JSON.parse(openApiText.value);
    } catch {
      alert("OpenAPI 规范 JSON 格式无效，请检查「OpenAPI 契约」中的内容。");
      return;
    }
  }

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: payload.title,
      goal: payload.goal,
      kind: "api-debug",
      environment: "sandbox",
      mode: runMode.value,
      mockScenario: payload.scenario ?? mockScenario.value,
      enableReviewer: enableReviewer.value,
      ...(parsedOpenApi ? { openApiDocument: parsedOpenApi } : {})
    })
  });

  const created = await res.json();
  if (!res.ok) {
    alert(created.message || "启动诊断失败");
    return;
  }

  currentRunId.value = created.runId;
  attachStream(created.runId);
  await refreshRuns();
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (inputMode.value === "natural") {
    // Ctrl+Enter / Cmd+Enter：若输入框为空，直接一键发送 placeholder 示例问题体验完整链路！
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!promptInput.value.trim()) {
        promptInput.value = defaultPlaceholderGoal.value;
      }
      void handleSend();
      return;
    }
    // 普通 Enter 发送，Shift+Enter 换行
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
    return;
  }
  // cURL / OpenAPI 代码输入模式下：Ctrl+Enter 或 Cmd+Enter 发送
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void handleSend();
  }
}

async function renameRun(item: RunSummary) {
  const nextTitle = window.prompt("重命名会话标题：", item.title);
  if (!nextTitle || !nextTitle.trim() || nextTitle.trim() === item.title) return;
  const res = await fetch(`/api/runs/${item.runId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: nextTitle.trim() })
  });
  if (res.ok) {
    if (currentSnapshot.value?.runId === item.runId) {
      currentSnapshot.value.task.title = nextTitle.trim();
    }
    await refreshRuns();
  } else {
    alert(`重命名失败（HTTP ${res.status}），若刚更新代码请先重启 npm run serve。`);
  }
}

async function toggleArchiveRun(item: RunSummary) {
  const res = await fetch(`/api/runs/${item.runId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ archived: !item.archived })
  });
  if (res.ok) {
    if (currentSnapshot.value?.runId === item.runId) {
      currentSnapshot.value.archived = !item.archived;
    }
    await refreshRuns();
  } else {
    alert(`归档操作失败（HTTP ${res.status}），若刚更新代码请先重启 npm run serve。`);
  }
}

async function deleteRun(item: RunSummary) {
  if (!window.confirm(`确定永久删除会话「${item.title}」及其本地轨迹文件吗？`)) return;
  const res = await fetch(`/api/runs/${item.runId}`, { method: "DELETE" });
  if (res.ok) {
    if (currentRunId.value === item.runId) {
      startNewChat();
    }
    await refreshRuns();
  } else {
    alert(`删除失败（HTTP ${res.status}），若刚更新代码请先重启 npm run serve。`);
  }
}

async function handleSend() {
  if (streaming.value) return;

  if (inputMode.value === "curl") {
    if (!curlInput.value.trim()) return;
    await launchRun({
      title: "cURL 请求诊断与修复验证",
      goal: `请根据已加载的 OpenAPI 契约诊断以下失败的 cURL 请求，先复现基线响应，修正参数/请求头后实测验证返回 2xx 并给出带证据 ID 的结论：\n\n${curlInput.value.trim()}`,
      scenario: "orders-debug"
    });
    return;
  }

  if (inputMode.value === "openapi") {
    const goal =
      promptInput.value.trim() ||
      "请基于当前提交的 OpenAPI 规范检索核心下单接口并完成一次失败复现与 2xx 修正验证。";
    await launchRun({
      title: "OpenAPI 契约诊断",
      goal,
      scenario: "orders-debug"
    });
    return;
  }

  const text = promptInput.value.trim();
  if (!text) return;
  const scenario = /支付|扣款|payment|charge/i.test(text) ? "payment-approval" : "orders-debug";
  promptInput.value = "";
  await launchRun({
    title: text.slice(0, 26) + (text.length > 26 ? "..." : ""),
    goal: text,
    scenario
  });
}

async function runStarterCard(kind: "curl-orders" | "payment-hitl" | "openapi-custom") {
  if (kind === "curl-orders") {
    const p = presets.value[0];
    if (p) await launchRun({ title: p.title, goal: p.goal, scenario: "orders-debug" });
    return;
  }
  if (kind === "payment-hitl") {
    const p = presets.value[1];
    if (p) await launchRun({ title: p.title, goal: p.goal, scenario: "payment-approval" });
    return;
  }
  inputMode.value = "openapi";
}

async function submitApproval(decision: "approved" | "denied") {
  if (!currentRunId.value || !pendingApproval.value) return;
  approvalBusy.value = true;
  try {
    const res = await fetch(
      `/api/runs/${currentRunId.value}/approvals/${pendingApproval.value.approvalId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          decidedBy: "developer",
          note: approvalNote.value
        })
      }
    );
    const data = await res.json();
    if (res.ok) {
      currentSnapshot.value = data.snapshot;
      const evRes = await fetch(`/api/runs/${currentRunId.value}/events`).then((r) => r.json());
      events.value = evRes.events ?? [];
      await refreshRuns();
    } else {
      alert(data.message || "审批提交失败");
    }
  } finally {
    approvalBusy.value = false;
  }
}

async function triggerEvaluation(mode: "offline" | "live") {
  evalRunning.value = true;
  try {
    const res = await fetch("/api/eval/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode })
    });
    const data = await res.json();
    if (res.ok) evalReport.value = data;
    else alert(data.message || "评测失败");
  } finally {
    evalRunning.value = false;
  }
}

function openEvidenceById(id: string) {
  const found = currentSnapshot.value?.evidence.find((e) => e.id === id);
  if (found) inspectedEvidence.value = found;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    running: "诊断中",
    waiting_approval: "待人工审批",
    resolved: "已验证完成",
    unresolved: "未完成核验",
    blocked: "已阻断",
    failed: "执行失败",
    cancelled: "已取消"
  };
  return map[status] ?? status;
}

function badgeClass(status: string): string {
  if (status === "resolved" || status === "pass") return "ok";
  if (status === "waiting_approval" || status === "running") return "warn";
  if (status === "blocked" || status === "failed" || status === "block") return "danger";
  return "info";
}

onMounted(() => {
  void loadBootstrap();
});
</script>

<template>
  <div class="layout">
    <!-- 左侧边栏（DSH 极简结构：品牌 + 新会话 + 工具入口 + 工作区历史会话） -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <div class="brand-row">
          <div class="brand-logo">
            <div class="logo-badge">π</div>
            <h1 class="brand-title">A-Pidoc</h1>
            <span class="brand-chip">HARNESS</span>
          </div>
        </div>

        <button class="new-chat-btn" @click="startNewChat">
          <span>⊕</span> 新会话
        </button>
      </div>

      <div class="sidebar-nav">
        <button class="sidebar-nav-btn" @click="evalOpen = true">
          <span>◎ 评测中心 (Raw vs Harness)</span>
          <span class="badge ok" v-if="evalReport">{{ evalReport.harnessSummary.passRate }}%</span>
        </button>
        <button class="sidebar-nav-btn" @click="drawerOpen = true">
          <span>▦ 观测与回放面板</span>
          <span style="font-size: 11px; color: var(--text-muted)">{{ currentSnapshot?.spans.length ?? 0 }}</span>
        </button>
      </div>

      <div class="sidebar-section-label">
        <span>工作区 · 诊断历史</span>
        <span>{{ runs.length }}</span>
      </div>

      <div class="sidebar-filter-tabs">
        <button class="filter-chip" :class="{ active: historyFilter === 'active' }" @click="historyFilter = 'active'">
          活跃 ({{ activeRuns.length }})
        </button>
        <button
          class="filter-chip"
          :class="{ active: historyFilter === 'archived' }"
          @click="historyFilter = 'archived'"
        >
          已归档 ({{ archivedRuns.length }})
        </button>
      </div>

      <div class="history-list">
        <div
          v-for="item in visibleRuns"
          :key="item.runId"
          class="history-item"
          :class="{ active: item.runId === currentRunId }"
          @click="selectRun(item.runId)"
        >
          <div class="history-title-row">
            <span class="status-dot" :class="item.status"></span>
            <span class="history-title">{{ item.title }}</span>
            <div class="history-actions" @click.stop>
              <button class="tiny-action-btn" title="重命名" @click="renameRun(item)">✎</button>
              <button
                class="tiny-action-btn"
                :title="item.archived ? '取消归档' : '归档会话'"
                @click="toggleArchiveRun(item)"
              >
                {{ item.archived ? "↩" : "◫" }}
              </button>
              <button class="tiny-action-btn danger" title="删除会话" @click="deleteRun(item)">✕</button>
            </div>
          </div>
          <div class="history-meta">
            {{ statusLabel(item.status) }} · {{ item.metrics.toolCalls }} 工具 · {{ item.metrics.durationMs }}ms
          </div>
        </div>
        <div v-if="!visibleRuns.length" style="padding: 12px 10px; font-size: 12px; color: var(--text-muted)">
          {{ historyFilter === "active" ? "暂无活跃会话" : "暂无已归档会话" }}
        </div>
      </div>

      <div class="sidebar-footer">
        <span>Pi Core 0.85.1 · Skills {{ health?.skills.length ?? 0 }}</span>
        <button class="icon-btn" style="padding: 3px 8px" @click="toggleTheme">
          {{ theme === "dark" ? "☀ 浅色" : "☾ 深灰" }}
        </button>
      </div>
    </aside>

    <!-- 右侧主区 -->
    <div class="main-area">
      <!-- DSH 双层 Topbar：上行标题 + 下行「对话 / 轨迹」下划线切换 -->
      <header class="topbar-wrap">
        <div class="topbar-row-1">
          <div style="display: flex; align-items: center; gap: 10px; min-width: 0">
            <span class="session-heading">
              {{ currentSnapshot?.task.title || "新建 API 联调诊断" }}
            </span>
            <span v-if="currentSnapshot" class="badge" :class="badgeClass(currentSnapshot.status)">
              {{ statusLabel(currentSnapshot.status) }}
            </span>
          </div>

          <div class="topbar-actions">
            <button class="icon-btn" :class="{ active: drawerOpen }" @click="drawerOpen = !drawerOpen">
              <span>观测面板</span>
              <span v-if="currentSnapshot" style="font-family: var(--mono); color: var(--accent)">
                {{ currentSnapshot.spans.length }}
              </span>
            </button>
          </div>
        </div>

        <div class="topbar-tabs">
          <button class="underline-tab" :class="{ active: mainView === 'chat' }" @click="mainView = 'chat'">
            对话
          </button>
          <button class="underline-tab" :class="{ active: mainView === 'trace' }" @click="mainView = 'trace'">
            轨迹 <span v-if="events.length" style="font-size: 11px; color: var(--text-muted)">({{ events.length }})</span>
          </button>
        </div>
      </header>

      <!-- 主内容滚动区 -->
      <main class="content-scroll">
        <div class="center-column">
          <!-- Tab 1：默认「对话与结果」 -->
          <template v-if="mainView === 'chat'">
            <div v-if="!currentRunId" class="welcome-box">
              <div class="welcome-logo">π</div>
              <h2>把失败的 API 请求交给我，用真实响应验证修复</h2>
              <p>
                直接输入<strong>自然语言故障</strong>、粘贴 <strong>cURL 命令</strong> 或导入
                <strong>OpenAPI 文档</strong>。写操作前主动挂起等待你批准，并附带可点击核验的 SHA-256 证据链。
              </p>

              <div class="starter-grid">
                <div class="starter-card" @click="runStarterCard('curl-orders')">
                  <div class="starter-tag">自动诊断闭环</div>
                  <div class="starter-title">排查订单接口 415 / 400 故障</div>
                  <div class="starter-desc">检索 8 端点 OpenAPI 契约，复现失败并修正后实测 201 通过。</div>
                </div>
                <div class="starter-card" @click="runStarterCard('payment-hitl')">
                  <div class="starter-tag">HITL 人工审批</div>
                  <div class="starter-title">支付扣款写操作拦截与恢复</div>
                  <div class="starter-desc">体验写操作自动挂起，弹出防篡改审批卡，批准后精确放行。</div>
                </div>
                <div class="starter-card" @click="runStarterCard('openapi-custom')">
                  <div class="starter-tag">通用契约接入</div>
                  <div class="starter-title">导入自定义 OpenAPI / cURL</div>
                  <div class="starter-desc">切换底部输入模式接入你的真实本地接口与 OpenAPI 规范。</div>
                </div>
              </div>
            </div>

            <div v-else class="chat-thread">
              <div class="msg-user-wrap">
                <div class="msg-user">
                  <div style="white-space: pre-wrap">{{ currentSnapshot?.task.goal || "正在启动任务..." }}</div>
                </div>
              </div>

              <div class="msg-agent">
                <div class="agent-avatar">π</div>
                <div class="agent-body">
                  <!-- 紧凑可折叠进度条 -->
                  <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap">
                    <button class="thinking-pill" @click="thinkingExpanded = !thinkingExpanded">
                      <span>{{ streaming ? "⏳ 正在调用工具诊断..." : "✓ 已完成诊断推理" }}</span>
                      <span style="color: var(--text-muted)">
                        · {{ currentSnapshot?.metrics.toolCalls ?? 0 }} 工具 ·
                        {{ currentSnapshot?.evidence.length ?? 0 }} 证据
                        <template v-if="currentSnapshot?.metrics.durationMs">
                          · {{ currentSnapshot.metrics.durationMs }}ms
                        </template>
                      </span>
                      <span>{{ thinkingExpanded ? "▴" : "▾" }}</span>
                    </button>
                    <button
                      v-if="events.length"
                      class="icon-btn"
                      style="margin-bottom: 10px"
                      @click="mainView = 'trace'"
                    >
                      查看轨迹 →
                    </button>
                  </div>

                  <div v-if="thinkingExpanded" class="thinking-preview">
                    <div v-for="(line, idx) in stepHighlights" :key="idx">{{ idx + 1 }}. {{ line }}</div>
                    <div v-if="!stepHighlights.length" style="color: var(--text-muted)">等待首步工具执行...</div>
                  </div>

                  <!-- HITL 人工审批卡 -->
                  <div v-if="pendingApproval" class="approval-card">
                    <h4>⚠️ 变更操作已挂起：需要人工批准后才能继续</h4>
                    <p style="margin: 0 0 8px; font-size: 12.5px">
                      工具 <strong>{{ pendingApproval.toolName }}</strong>（风险：{{ pendingApproval.risk }}）· 参数哈希
                      <code>{{ pendingApproval.actionDigest.slice(0, 16) }}...</code>
                    </p>
                    <pre class="code-block">{{ JSON.stringify(pendingApproval.args, null, 2) }}</pre>
                    <div style="display: flex; gap: 8px; margin-top: 10px">
                      <input
                        v-model="approvalNote"
                        type="text"
                        style="flex: 1; padding: 6px 10px; border-radius: 7px; border: 1px solid var(--border-strong); background: var(--bg-input); color: var(--text-primary); font-size: 12px"
                      />
                      <button class="btn success" :disabled="approvalBusy" @click="submitApproval('approved')">
                        批准并继续
                      </button>
                      <button class="btn danger" :disabled="approvalBusy" @click="submitApproval('denied')">
                        拒绝
                      </button>
                    </div>
                  </div>

                  <!-- 最终结构化结果卡 -->
                  <div v-if="currentSnapshot?.proposal" class="result-card">
                    <div class="result-header">
                      <div>
                        <span style="font-size: 12px; color: var(--text-muted); margin-right: 8px">诊断根因</span>
                        <span class="root-cause-tag">{{ currentSnapshot.proposal.rootCause }}</span>
                      </div>
                      <span class="badge" :class="badgeClass(currentSnapshot.status)">
                        {{ statusLabel(currentSnapshot.status) }}
                      </span>
                    </div>

                    <p class="result-summary">{{ currentSnapshot.proposal.summary }}</p>

                    <div class="section-subtitle">已核验事实依据（点击引用查看脱敏原始观测）</div>
                    <div v-for="(claim, idx) in currentSnapshot.proposal.claims" :key="idx" class="claim-item">
                      <span>{{ claim.statement }}</span>
                      <button
                        v-for="evId in claim.evidenceIds"
                        :key="evId"
                        class="cite-chip"
                        @click="openEvidenceById(evId)"
                      >
                        [{{ evId }}]
                      </button>
                    </div>

                    <template v-if="currentSnapshot.proposal.recommendations?.length">
                      <div class="section-subtitle">修复建议</div>
                      <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: var(--text-secondary)">
                        <li v-for="(rec, i) in currentSnapshot.proposal.recommendations" :key="i">{{ rec }}</li>
                      </ul>
                    </template>

                    <div class="verify-strip">
                      <span
                        v-if="currentSnapshot.gateVerdict"
                        class="badge"
                        :class="currentSnapshot.gateVerdict.passed ? 'ok' : 'danger'"
                      >
                        EvidenceGate：{{ currentSnapshot.gateVerdict.passed ? "通过 ✓" : currentSnapshot.gateVerdict.reasons.join(", ") }}
                      </span>
                      <span
                        v-for="(rev, idx) in currentSnapshot.reviewVerdicts"
                        :key="idx"
                        class="badge"
                        :class="badgeClass(rev.verdict)"
                      >
                        Reviewer：{{ rev.verdict.toUpperCase() }} ({{ rev.modelId }})
                      </span>
                    </div>
                  </div>

                  <div v-else-if="!pendingApproval" class="result-card" style="font-size: 13px; color: var(--text-secondary)">
                    <div v-if="streaming">正在执行工具链与契约核验，结果将在此呈现...</div>
                    <div v-else>
                      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 4px">
                        {{ latestAssistantText || currentSnapshot?.finalReason || "任务已结束" }}
                      </div>
                      <div style="font-size: 12px; color: var(--text-muted)">
                        可切换顶部「轨迹」或打开右侧「观测面板」查看详细步骤。
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>

          <!-- Tab 2：DSH 风格紧凑轨迹视图（三泳道迷你甘特 + 彩色标签单行流） -->
          <template v-else>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; gap: 10px">
              <div style="font-size: 12px; color: var(--text-muted); display: flex; gap: 14px">
                <span>⏱ 时长 {{ currentSnapshot?.metrics.durationMs ?? 0 }}ms</span>
                <span>◫ 模型 {{ currentSnapshot?.metrics.modelCalls ?? 0 }} 次</span>
                <span>⚙ 工具 {{ currentSnapshot?.metrics.toolCalls ?? 0 }} 次</span>
              </div>
              <input
                v-model="traceFilter"
                type="text"
                placeholder="🔍 搜索轨迹步骤、工具名或证据..."
                style="width: 240px; padding: 5px 10px; border-radius: 7px; border: 1px solid var(--border); background: var(--bg-input); color: var(--text-primary); font-size: 12px"
              />
            </div>

            <!-- 真实时间流三泳道甘特总览条（输入 / 模型 / 工具按真实时间戳与持续时长定位） -->
            <div class="dsh-swimlanes" v-if="timelineData.totalMs > 0">
              <div class="dsh-lane">
                <span class="dsh-lane-label">输入</span>
                <div class="dsh-lane-track">
                  <div
                    v-for="seg in timelineData.segments.input"
                    :key="seg.id"
                    class="dsh-block"
                    :style="{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%`, background: seg.color }"
                    :title="seg.label"
                    @click="seg.targetSeq ? (expandedTraceSeq = expandedTraceSeq === seg.targetSeq ? null : seg.targetSeq) : null"
                  ></div>
                </div>
              </div>
              <div class="dsh-lane">
                <span class="dsh-lane-label">模型</span>
                <div class="dsh-lane-track">
                  <div
                    v-for="seg in timelineData.segments.model"
                    :key="seg.id"
                    class="dsh-block"
                    :style="{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%`, background: seg.color }"
                    :title="seg.label"
                  ></div>
                </div>
              </div>
              <div class="dsh-lane">
                <span class="dsh-lane-label">工具</span>
                <div class="dsh-lane-track">
                  <div
                    v-for="seg in timelineData.segments.tool"
                    :key="seg.id"
                    class="dsh-block"
                    :style="{ left: `${seg.leftPct}%`, width: `${seg.widthPct}%`, background: seg.color }"
                    :title="seg.label"
                  ></div>
                </div>
              </div>
              <div class="dsh-time-axis">
                <span></span>
                <div class="dsh-time-ticks">
                  <span>0ms</span>
                  <span>{{ Math.round(timelineData.totalMs * 0.25) }}ms</span>
                  <span>{{ Math.round(timelineData.totalMs * 0.5) }}ms</span>
                  <span>{{ Math.round(timelineData.totalMs * 0.75) }}ms</span>
                  <span>{{ timelineData.totalMs }}ms</span>
                </div>
              </div>
            </div>

            <!-- 紧凑单行彩色徽章轨迹列表（点击任意行展开完整 JSON） -->
            <div style="border-top: 1px solid var(--border)" v-if="compactTraceItems.length">
              <div v-for="(item, idx) in compactTraceItems" :key="item.seq" class="dsh-trace-row">
                <div
                  class="dsh-trace-summary"
                  @click="expandedTraceSeq = expandedTraceSeq === item.seq ? null : item.seq"
                >
                  <span class="dsh-tag" :class="item.tagClass">{{ item.tagLabel }}</span>
                  <span class="dsh-trace-line">{{ item.preview }}</span>
                  <span style="font-size: 11px; color: var(--text-muted); font-family: var(--mono)">
                    #{{ idx + 1 }}
                  </span>
                </div>
                <div v-if="expandedTraceSeq === item.seq" style="padding: 0 8px 10px 56px">
                  <pre class="code-block">{{ JSON.stringify(item.event.payload, null, 2) }}</pre>
                </div>
              </div>
            </div>
            <div v-else style="text-align: center; padding: 48px; color: var(--text-muted); font-size: 13px">
              暂无轨迹记录，请先发起一次诊断会话。
            </div>
          </template>
        </div>
      </main>

      <!-- DSH 风格圆润底部输入框 + 底部遥测状态条 -->
      <div class="composer-wrap">
        <div class="composer-box">
          <div class="composer-tabs">
            <div class="input-mode-pills">
              <button class="mode-pill" :class="{ active: inputMode === 'natural' }" @click="inputMode = 'natural'">
                自然语言
              </button>
              <button class="mode-pill" :class="{ active: inputMode === 'curl' }" @click="inputMode = 'curl'">
                cURL 请求
              </button>
              <button class="mode-pill" :class="{ active: inputMode === 'openapi' }" @click="inputMode = 'openapi'">
                OpenAPI 契约
              </button>
            </div>
            <span style="font-size: 11px; color: var(--text-muted)">
              {{ inputMode === "natural" ? "Enter 发送 · 空框 Ctrl+Enter 发送示例" : "Ctrl+Enter 发送" }}
            </span>
          </div>

          <textarea
            v-if="inputMode === 'natural'"
            v-model="promptInput"
            class="composer-textarea"
            rows="2"
            :placeholder="`${defaultPlaceholderGoal}（直接 Ctrl+Enter 可一键体验）`"
            @keydown="handleComposerKeydown"
          ></textarea>

          <textarea
            v-else-if="inputMode === 'curl'"
            v-model="curlInput"
            class="composer-textarea mono"
            rows="4"
            placeholder="粘贴失败的 curl 命令..."
            @keydown="handleComposerKeydown"
          ></textarea>

          <textarea
            v-else
            v-model="openApiText"
            class="composer-textarea mono"
            rows="6"
            placeholder="粘贴或编辑 OpenAPI 3.x / Swagger 2.0 JSON..."
            @keydown="handleComposerKeydown"
          ></textarea>

          <div class="composer-footer">
            <div class="composer-controls">
              <label style="display: flex; align-items: center; gap: 5px; cursor: pointer">
                <input type="checkbox" v-model="enableReviewer" />
                独立 Reviewer
              </label>
            </div>

            <div style="display: flex; align-items: center; gap: 8px">
              <select v-model="runMode" class="mini-select">
                <option value="mock">Mock 演示（免密钥）</option>
                <option value="live" :disabled="!health?.liveConfigured">
                  DeepSeek Live ({{ health?.defaultModel ?? "deepseek-chat" }})
                </option>
              </select>
              <button class="send-circle-btn" :disabled="streaming" title="发送诊断" @click="handleSend">
                ↑
              </button>
            </div>
          </div>
        </div>

        <!-- 类似 DSH 最底部的单行紧凑遥测栏 -->
        <div class="dsh-statusbar" v-if="currentSnapshot">
          <span>{{ currentSnapshot.metrics.modelCalls }} 轮 {{ currentSnapshot.metrics.toolCalls }} 步</span>
          <span>{{ currentSnapshot.metrics.totalTokens }} tokens</span>
          <span>{{ currentSnapshot.metrics.durationMs }}ms</span>
          <span>Evidence {{ currentSnapshot.evidence.length }}</span>
          <span style="cursor: pointer; color: var(--accent)" @click="drawerOpen = true">展开观测面板</span>
        </div>
      </div>
    </div>

    <!-- 右侧按需展开的开发者观测抽屉 -->
    <ObservabilityDrawer
      :open="drawerOpen"
      :snapshot="currentSnapshot"
      :events="events"
      @close="drawerOpen = false"
    />

    <!-- 评测中心弹窗 -->
    <EvalModal
      :open="evalOpen"
      :report="evalReport"
      :running="evalRunning"
      :live-configured="Boolean(health?.liveConfigured)"
      @close="evalOpen = false"
      @run="triggerEvaluation"
    />

    <!-- 点击证据引用后的脱敏详情弹窗 -->
    <div v-if="inspectedEvidence" class="modal-backdrop" @click.self="inspectedEvidence = null">
      <div class="modal-card" style="width: min(680px, 92vw)">
        <div class="drawer-header">
          <div>
            <strong style="font-family: var(--mono); font-size: 13.5px">{{ inspectedEvidence.id }}</strong>
            <div style="font-size: 11px; color: var(--text-muted)">SHA-256: {{ inspectedEvidence.sha256 }}</div>
          </div>
          <button class="btn" @click="inspectedEvidence = null">关闭</button>
        </div>
        <div class="drawer-body">
          <div style="font-size: 13px; margin-bottom: 10px">
            <strong>工具：</strong>{{ inspectedEvidence.toolName }} · <strong>摘要：</strong>{{ inspectedEvidence.summary }}
          </div>
          <pre class="code-block" style="max-height: 460px">{{ JSON.stringify(inspectedEvidence.data, null, 2) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>
