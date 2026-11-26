import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runEvaluationSuite } from "../eval/runner.js";
import type { HarnessEvent } from "../kernel/types.js";
import { safeError } from "../shared/errors.js";
import { buildDemoOpenApiSpec, createDemoSandboxRoutes } from "./demo-sandbox.js";
import { RunManager } from "./run-manager.js";

const createRunBodySchema = z.object({
  title: z.string().max(160).optional(),
  goal: z.string().min(3).max(4_000),
  kind: z.enum(["api-debug", "contract-migration", "general"]).optional(),
  environment: z.enum(["sandbox", "staging", "production"]).optional(),
  mode: z.enum(["live", "mock"]).optional(),
  mockScenario: z.enum(["orders-debug", "payment-approval"]).optional(),
  openApiDocument: z.unknown().optional(),
  allowedHosts: z.array(z.string().min(1)).max(20).optional(),
  allowedPorts: z.array(z.number().int().min(1).max(65535)).max(20).optional(),
  requireApprovalForMutations: z.boolean().optional(),
  enableReviewer: z.boolean().optional()
});

const approvalDecisionSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  decidedBy: z.string().min(1).max(80).default("developer"),
  note: z.string().max(300).optional()
});

const patchRunSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  archived: z.boolean().optional()
});

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png"
};

export interface ServerOptions {
  port?: number;
  host?: string;
  runsDir?: string;
  webDistDir?: string;
}

/**
 * 构建 Hono 后端应用：
 * - REST API: 任务创建/查询/取消、人工审批恢复、评测运行与报告查询
 * - SSE 实时流: 推送 Agent 思考、工具调用、Context Compaction、审批弹窗、Reviewer 裁决
 * - /sandbox/*: 内置 8 端点电商靶场
 * - 静态托管 Vue 3 前端产物（若 web/dist 存在）
 */
export async function createServerApp(options: ServerOptions = {}): Promise<{ app: Hono; manager: RunManager }> {
  const port = options.port ?? 3000;
  const host = options.host ?? "127.0.0.1";
  const baseUrl = `http://${host}:${port}`;
  const manager = new RunManager(baseUrl, options.runsDir);
  await manager.initialize();

  const app = new Hono();
  app.use("/api/*", cors());

  app.onError((error, c) => {
    const safe = safeError(error);
    return c.json({ error: safe.code, message: safe.message }, safe.httpStatus as 400);
  });

  // 1. 挂载内置 8 端点诊断靶场
  app.route("/sandbox", createDemoSandboxRoutes());

  // 2. 系统状态与 Skill 目录
  app.get("/api/health", (c) => {
    const liveConfigured = Boolean(process.env.DEEPSEEK_API_KEY || process.env.A_PIDOC_API_KEY);
    return c.json({
      ok: true,
      version: "2.0.0",
      engine: "@earendil-works/pi-agent-core@0.85.1",
      baseUrl,
      liveConfigured,
      defaultModel: process.env.A_PIDOC_MODEL ?? "deepseek-chat",
      skills: manager.skills.list().map((item) => ({
        name: item.name,
        description: item.description
      }))
    });
  });

  // 3. 预设演示任务与内置 OpenAPI 文档
  app.get("/api/demo/presets", (c) => {
    return c.json({
      openApiDocument: buildDemoOpenApiSpec(baseUrl),
      presets: [
        {
          id: "orders-debug",
          title: "订单接口 415/400 故障诊断与修复验证",
          kind: "api-debug",
          mockScenario: "orders-debug",
          goal: `排查 POST ${baseUrl}/sandbox/orders 失败原因：客户端当前以 Content-Type: text/plain 发送 {"sku":"SKU-100","amount":"99","currency":"CNY"}。请先检索 OpenAPI 规范，复现失败基线，修正后实测返回 2xx 并提交带证据 ID 的报告。`
        },
        {
          id: "payment-approval",
          title: "支付扣款接口排错（触发 HITL 人工审批门禁）",
          kind: "api-debug",
          mockScenario: "payment-approval",
          goal: `核对 POST ${baseUrl}/sandbox/payments/charge 接口契约，并通过 execute_http_mutation 为订单 ord_demo_2026 执行 9900 分的沙箱扣款验证（需等待人工批准后执行）。`
        }
      ]
    });
  });

  // 4. 运行列表与详情
  app.get("/api/runs", async (c) => {
    const runs = await manager.store.listRuns(50);
    return c.json({ runs });
  });

  app.post("/api/runs", async (c) => {
    const body = await c.req.json();
    const parsed = createRunBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        { error: "INVALID_REQUEST", issues: parsed.error.issues },
        400
      );
    }

    const request = parsed.data;
    const created = await manager.startRun({
      goal: request.goal,
      ...(request.title !== undefined ? { title: request.title } : {}),
      ...(request.kind !== undefined ? { kind: request.kind } : {}),
      ...(request.environment !== undefined ? { environment: request.environment } : {}),
      ...(request.mode !== undefined ? { mode: request.mode } : {}),
      ...(request.mockScenario !== undefined ? { mockScenario: request.mockScenario } : {}),
      ...(request.openApiDocument !== undefined ? { openApiDocument: request.openApiDocument } : {}),
      ...(request.allowedHosts !== undefined ? { allowedHosts: request.allowedHosts } : {}),
      ...(request.allowedPorts !== undefined ? { allowedPorts: request.allowedPorts } : {}),
      ...(request.requireApprovalForMutations !== undefined
        ? { requireApprovalForMutations: request.requireApprovalForMutations }
        : {}),
      ...(request.enableReviewer !== undefined ? { enableReviewer: request.enableReviewer } : {})
    });
    return c.json(created, 202);
  });

  app.get("/api/runs/:runId", async (c) => {
    const snapshot = await manager.store.loadSnapshot(c.req.param("runId"));
    if (!snapshot) return c.json({ error: "NOT_FOUND", message: "Run not found" }, 404);
    return c.json({ snapshot, active: manager.isRunning(snapshot.runId) });
  });

  app.patch("/api/runs/:runId", async (c) => {
    const body = await c.req.json();
    const parsed = patchRunSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, 400);
    }
    const updated = await manager.store.updateRunMeta(c.req.param("runId"), {
      ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
      ...(parsed.data.archived !== undefined ? { archived: parsed.data.archived } : {})
    });
    if (!updated) return c.json({ error: "NOT_FOUND", message: "Run not found" }, 404);
    return c.json({ snapshot: updated });
  });

  app.delete("/api/runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    manager.cancelRun(runId);
    manager.clearRunMemory(runId);
    const deleted = await manager.store.deleteRun(runId);
    if (!deleted) return c.json({ error: "NOT_FOUND", message: "Run not found" }, 404);
    return c.json({ deleted: true, runId });
  });

  app.get("/api/runs/:runId/events", async (c) => {
    const runId = c.req.param("runId");
    const events = await manager.getEvents(runId);
    return c.json({ runId, events });
  });

  // 5. SSE 实时事件流（内存热补发 + 实时推送，零事件丢失）
  app.get("/api/runs/:runId/stream", async (c) => {
    const runId = c.req.param("runId");
    return streamSSE(c, async (stream) => {
      let lastSeq = 0;
      const sendEvent = async (event: HarnessEvent) => {
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        await stream.writeSSE({
          id: String(event.seq),
          event: event.type,
          data: JSON.stringify(event)
        });
      };

      const history = await manager.getEvents(runId);
      for (const event of history) {
        await sendEvent(event);
      }

      if (!manager.isRunning(runId)) {
        const snapshot = await manager.store.loadSnapshot(runId);
        await stream.writeSSE({
          event: "stream_closed",
          data: JSON.stringify({ runId, status: snapshot?.status ?? "unknown" })
        });
        return;
      }

      await new Promise<void>((resolvePromise) => {
        const unsubscribe = manager.subscribe(runId, (event) => {
          void sendEvent(event).then(() => {
            if (event.type === "run_finished") {
              unsubscribe();
              resolvePromise();
            }
          });
        });

        const heartbeat = setInterval(() => {
          void stream.writeSSE({ event: "ping", data: JSON.stringify({ at: Date.now() }) });
        }, 15_000);
        heartbeat.unref();

        stream.onAbort(() => {
          clearInterval(heartbeat);
          unsubscribe();
          resolvePromise();
        });
      });
    });
  });

  // 6. Human-in-the-loop 审批决策与恢复
  app.post("/api/runs/:runId/approvals/:approvalId", async (c) => {
    const body = await c.req.json();
    const parsed = approvalDecisionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "INVALID_REQUEST", issues: parsed.error.issues }, 400);
    }

    const snapshot = await manager.decideApproval({
      runId: c.req.param("runId"),
      approvalId: c.req.param("approvalId"),
      decision: parsed.data.decision,
      decidedBy: parsed.data.decidedBy,
      ...(parsed.data.note ? { note: parsed.data.note } : {})
    });

    return c.json({ snapshot });
  });

  app.post("/api/runs/:runId/cancel", (c) => {
    const cancelled = manager.cancelRun(c.req.param("runId"));
    return c.json({ cancelled });
  });

  // 7. 评测结果查询与触发（Raw Pi vs Harness Pi）
  const latestEvalFile = resolve(".private/eval/latest-report.json");
  app.get("/api/eval/latest", async (c) => {
    try {
      const raw = await readFile(latestEvalFile, "utf8");
      return c.json(JSON.parse(raw));
    } catch {
      const report = await runEvaluationSuite({ mode: "offline" });
      return c.json(report);
    }
  });

  app.post("/api/eval/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { mode?: "offline" | "live" };
    const mode = body.mode === "live" ? "live" : "offline";
    const report = await runEvaluationSuite({ mode });
    return c.json(report);
  });

  // 8. 生产模式静态托管 Vue 3 构建产物
  const webDist = resolve(options.webDistDir ?? "web/dist");
  if (existsSync(webDist)) {
    app.get("*", async (c) => {
      const reqPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const target = join(webDist, reqPath);
      const fileToServe = existsSync(target) ? target : join(webDist, "index.html");
      const content = await readFile(fileToServe);
      const mime = MIME_TYPES[extname(fileToServe)] ?? "application/octet-stream";
      return c.body(new Uint8Array(content), 200, { "Content-Type": mime });
    });
  }

  return { app, manager };
}

export async function startHttpServer(options: ServerOptions = {}) {
  const port = options.port ?? 3000;
  const host = options.host ?? "127.0.0.1";
  const { app } = await createServerApp({ ...options, port, host });
  let server!: ReturnType<typeof serve>;
  const boundPort = await new Promise<number>((resolvePort) => {
    server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
      resolvePort(info.port);
    });
  });
  console.log(`A-Pidoc v2 server running at http://${host}:${boundPort}`);
  return { server, port: boundPort };
}
