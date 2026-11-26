import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { AgentHarnessRuntime } from "../src/kernel/harness.js";
import { SessionStore } from "../src/kernel/session-store.js";
import { SkillRegistry } from "../src/kernel/skill-loader.js";
import { createServerApp } from "../src/server/app.js";
import { buildDemoOpenApiSpec } from "../src/server/demo-sandbox.js";
import { MOCK_MODEL } from "../src/server/mock-stream.js";
import { redactRequest, redactText } from "../src/shared/redaction.js";
import { RequestPolicy } from "../src/shared/request-policy.js";
import { createCoreHarnessTools } from "../src/tools/core-tools.js";
import { OpenApiIndex } from "../src/tools/openapi-search.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createWorkspaceMigrationTools, diffOpenApiContracts, scanRepositoryCalls } from "../src/tools/workspace-tools.js";

function scriptedStream(
  steps: Array<(messages: unknown[]) => { text?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }>
): StreamFn {
  let cursor = 0;
  return (model: Model<any>, context) => {
    const fn = steps[Math.min(cursor, steps.length - 1)]!;
    cursor += 1;
    const plan = fn(context.messages);
    const content: AssistantMessage["content"] = [];
    if (plan.text) content.push({ type: "text", text: plan.text });
    if (plan.toolCall) {
      content.push({
        type: "toolCall",
        id: plan.toolCall.id,
        name: plan.toolCall.name,
        arguments: plan.toolCall.arguments
      });
    }
    const msg: AssistantMessage = {
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 280,
        cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 }
      },
      stopReason: plan.toolCall ? "toolUse" : "stop",
      timestamp: Date.now()
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: plan.toolCall ? "toolUse" : "stop", message: msg });
      stream.end(msg);
    });
    return stream;
  };
}

test("OpenApiIndex retrieves relevant operations by path, method, and body field", () => {
  const index = OpenApiIndex.fromRawDocument(buildDemoOpenApiSpec("http://127.0.0.1:3000"));
  assert.equal(index.operations.length, 8);

  const paymentHits = index.search("totalCents charge", 3);
  assert.equal(paymentHits[0]?.operation.operationId, "chargePayment");

  const orderOp = index.getByIdOrPath("/sandbox/orders", "POST");
  assert.ok(orderOp);
  assert.equal(orderOp.requiredContentType, "application/json");
  assert.ok(orderOp.bodyFieldNames.includes("amount"));
});

test("Security policy blocks SSRF private targets and redacts credentials", async () => {
  const policy = new RequestPolicy({
    allowedHosts: ["api.example.com", "127.0.0.1"],
    allowedPorts: [80, 443, 3000],
    resolveHost: async (host) => (host === "api.example.com" ? ["169.254.169.254"] : ["127.0.0.1"])
  });

  await assert.rejects(
    () =>
      policy.assertResolvedAddressAllowed({
        method: "GET",
        url: "https://api.example.com/v1/orders",
        headers: {},
        body: null
      }),
    /private network address/i
  );

  const redacted = redactRequest({
    method: "POST",
    url: "http://127.0.0.1:3000/orders?api_key=sk-secret12345678",
    headers: { Authorization: "Bearer supersecretvalue1234", "Content-Type": "application/json" },
    body: { token: "tok_99999", email: "user@example.com" }
  });

  assert.equal(redacted.headers.Authorization, "[REDACTED]");
  assert.equal((redacted.body as Record<string, unknown>).token, "[REDACTED]");
  assert.equal(redactText("contact 13800138000"), "contact [REDACTED]");
});

test("Contract migration workflow enforces HITL approval before isolated patch and tests", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "a-pidoc-mig-"));
  const sourceDir = join(tempRoot, "source-repo");
  const isolatedDir = join(tempRoot, "isolated-workspace");
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    join(sourceDir, "client.ts"),
    'export async function sendOrder() {\n  return fetch("https://api.demo.local/orders", { method: "POST", body: JSON.stringify({ amount: "42" }) });\n}\n',
    "utf8"
  );

  const prevSpec = {
    openapi: "3.0.3",
    info: { title: "Orders", version: "1.0.0" },
    paths: {
      "/orders": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", required: ["amount"], properties: { amount: { type: "string" } } }
              }
            }
          }
        }
      }
    }
  };

  const nextSpec = {
    openapi: "3.0.3",
    info: { title: "Orders", version: "2.0.0" },
    paths: {
      "/orders": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", required: ["amount"], properties: { amount: { type: "number" } } }
              }
            }
          }
        }
      }
    }
  };

  try {
    const diff = diffOpenApiContracts(prevSpec, nextSpec);
    assert.equal(diff.summary.breaking, 1);
    const scanned = await scanRepositoryCalls(sourceDir);
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0]?.bodyObject?.amount, "42");

    const skills = new SkillRegistry();
    await skills.loadFromDirectory(resolve(".pi/skills"));
    const store = new SessionStore(join(tempRoot, "runs"));
    const registry = new ToolRegistry();
    for (const tool of createWorkspaceMigrationTools({
      sourceDir,
      isolatedWorkspaceDir: isolatedDir,
      previousOpenApi: prevSpec,
      nextOpenApi: nextSpec
    })) {
      registry.register(tool);
    }
    for (const tool of createCoreHarnessTools({ skills, registry })) registry.register(tool);

    let diffId = "";
    let proposalId = "";
    let patchId = "";
    let testId = "";

    const extractIds = (messages: unknown[]) => {
      for (const m of messages as Array<{ role?: string; content?: Array<{ text?: string }> }>) {
        if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
        const text = m.content.map((c) => c.text ?? "").join("");
        const match = text.match(/"evidenceId"\s*:\s*"([^"]+)"/);
        const id = match?.[1];
        if (!id) continue;
        if (id.startsWith("contract_diff_")) diffId = id;
        if (id.startsWith("patch_proposal_")) proposalId = id;
        if (id.startsWith("isolated_patch_")) patchId = id;
        if (id.startsWith("test_run_")) testId = id;
      }
    };

    const leadStream = scriptedStream([
      () => ({ toolCall: { id: "c1", name: "diff_openapi_contracts", arguments: {} } }),
      () => ({ toolCall: { id: "c2", name: "propose_migration_patches", arguments: {} } }),
      (msgs) => {
        extractIds(msgs);
        return { toolCall: { id: "c3", name: "apply_patches_isolated", arguments: { proposalEvidenceId: proposalId } } };
      },
      (msgs) => {
        extractIds(msgs);
        return { toolCall: { id: "c4", name: "apply_patches_isolated", arguments: { proposalEvidenceId: proposalId } } };
      },
      (msgs) => {
        extractIds(msgs);
        return { toolCall: { id: "c5", name: "run_isolated_tests", arguments: { patchEvidenceId: patchId } } };
      },
      (msgs) => {
        extractIds(msgs);
        return { toolCall: { id: "c6", name: "run_isolated_tests", arguments: { patchEvidenceId: patchId } } };
      },
      (msgs) => {
        extractIds(msgs);
        return {
          toolCall: {
            id: "c7",
            name: "submit_completion",
            arguments: {
              proposal: {
                summary: "Completed lossless string-to-number migration and passed isolated contract tests.",
                rootCause: "CONTRACT_FIELD_TYPE_CHANGED",
                claims: [{ statement: "Isolated tests passed after patch", evidenceIds: [diffId, patchId, testId] }],
                migrationArtifacts: {
                  contractDiffId: diffId,
                  patchArtifactId: patchId,
                  testRunId: testId,
                  testExitCode: 0
                }
              }
            }
          }
        };
      },
      () => ({ text: "Done." })
    ]);

    const reviewerStream = scriptedStream([
      () => ({ text: JSON.stringify({ verdict: "pass", rationale: "Migration evidence verified.", issues: [] }) })
    ]);

    const runtime = new AgentHarnessRuntime({
      model: MOCK_MODEL,
      streamFn: leadStream,
      reviewerStreamFn: reviewerStream,
      store,
      registry,
      skills,
      enableReviewer: true
    });

    const step1 = await runtime.start({
      title: "Migrate orders client",
      goal: "Diff contracts, patch isolated workspace, run tests.",
      kind: "contract-migration",
      environment: "sandbox"
    });
    assert.equal(step1.status, "waiting_approval");
    const patchApproval = step1.approvals.find((a) => a.status === "pending" && a.toolName === "apply_patches_isolated");
    assert.ok(patchApproval);

    const step2 = await runtime.decideApprovalAndResume({
      runId: step1.runId,
      approvalId: patchApproval.approvalId,
      decision: "approved",
      decidedBy: "reviewer-1"
    });
    assert.equal(step2.status, "waiting_approval");
    const testApproval = step2.approvals.find((a) => a.status === "pending" && a.toolName === "run_isolated_tests");
    assert.ok(testApproval);

    const finalRun = await runtime.decideApprovalAndResume({
      runId: step2.runId,
      approvalId: testApproval.approvalId,
      decision: "approved",
      decidedBy: "reviewer-1"
    });

    assert.equal(finalRun.status, "resolved");
    assert.equal(finalRun.gateVerdict?.passed, true);
    assert.equal(finalRun.reviewVerdicts[0]?.verdict, "pass");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Hono server exposes health, demo presets, sandbox routes, and run APIs", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "a-pidoc-srv-"));
  try {
    const { app } = await createServerApp({ port: 3456, runsDir: join(tempRoot, "runs") });

    const healthRes = await app.request("/api/health");
    assert.equal(healthRes.status, 200);
    const healthJson = (await healthRes.json()) as { ok: boolean; skills: unknown[] };
    assert.equal(healthJson.ok, true);
    assert.ok(healthJson.skills.length >= 2);

    const presetsRes = await app.request("/api/demo/presets");
    assert.equal(presetsRes.status, 200);
    const presetsJson = (await presetsRes.json()) as { presets: unknown[] };
    assert.equal(presetsJson.presets.length, 2);

    const sandbox415 = await app.request("/sandbox/orders", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ sku: "SKU-1", amount: 10, currency: "CNY" })
    });
    assert.equal(sandbox415.status, 415);

    const sandbox201 = await app.request("/sandbox/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sku: "SKU-1", amount: 10, currency: "CNY" })
    });
    assert.equal(sandbox201.status, 201);

    // 验证会话重命名、归档与删除接口
    const createdRes = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Temp Session", goal: "Check orders", mode: "mock" })
    });
    assert.equal(createdRes.status, 202);
    const { runId } = (await createdRes.json()) as { runId: string };
    await new Promise((r) => setTimeout(r, 150));

    const patchRes = await app.request(`/api/runs/${runId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed Session", archived: true })
    });
    assert.equal(patchRes.status, 200);
    const patched = (await patchRes.json()) as { snapshot: { task: { title: string }; archived?: boolean } };
    assert.equal(patched.snapshot.task.title, "Renamed Session");
    assert.equal(patched.snapshot.archived, true);

    const delRes = await app.request(`/api/runs/${runId}`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const afterDel = await app.request(`/api/runs/${runId}`);
    assert.equal(afterDel.status, 404);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
