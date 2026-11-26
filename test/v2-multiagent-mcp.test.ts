import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { AgentHarnessRuntime } from "../src/kernel/harness.js";
import { SessionStore } from "../src/kernel/session-store.js";
import { SkillRegistry } from "../src/kernel/skill-loader.js";
import { createApidocMcpServer } from "../src/mcp/server.js";
import { buildDemoOpenApiSpec } from "../src/server/demo-sandbox.js";
import { MOCK_MODEL } from "../src/server/mock-stream.js";
import { createCoreHarnessTools } from "../src/tools/core-tools.js";
import { createOpenApiTools, OpenApiIndex } from "../src/tools/openapi-search.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function emitTurn(
  model: Model<any>,
  turn: { text?: string; toolCall?: { id: string; name: string; arguments: Record<string, unknown> } }
) {
  const content: AssistantMessage["content"] = [];
  if (turn.text) content.push({ type: "text", text: turn.text });
  if (turn.toolCall) {
    content.push({
      type: "toolCall",
      id: turn.toolCall.id,
      name: turn.toolCall.name,
      arguments: turn.toolCall.arguments
    });
  }
  const msg: AssistantMessage = {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 180,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 240,
      cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 }
    },
    stopReason: turn.toolCall ? "toolUse" : "stop",
    timestamp: Date.now()
  };
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "done", reason: turn.toolCall ? "toolUse" : "stop", message: msg });
    stream.end(msg);
  });
  return stream;
}

test("Multi-Agent specialist delegation runs in isolated read-only context and records telemetry", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "a-pidoc-multi-"));
  try {
    const skills = new SkillRegistry();
    await skills.loadFromDirectory(resolve(".pi/skills"));
    const store = new SessionStore(join(tempRoot, "runs"));
    const openApiIndex = OpenApiIndex.fromRawDocument(buildDemoOpenApiSpec("http://127.0.0.1:3000"));

    let specialistStep = 0;
    const specialistStream: StreamFn = (model) => {
      specialistStep += 1;
      if (specialistStep === 1) {
        return emitTurn(model, {
          toolCall: { id: "sp_1", name: "search_openapi", arguments: { query: "shipping", limit: 2 } }
        });
      }
      return emitTurn(model, {
        text: "Specialist Brief: POST /sandbox/shipping/quote requires region (CN-BJ|CN-SH|US-CA) and weightGrams >= 10."
      });
    };

    let leadStep = 0;
    const leadStream: StreamFn = (model) => {
      leadStep += 1;
      if (leadStep === 1) {
        return emitTurn(model, {
          toolCall: {
            id: "ld_1",
            name: "delegate_specialist",
            arguments: { focus: "shipping-contract", question: "Find shipping quote endpoint requirements." }
          }
        });
      }
      return emitTurn(model, { text: "Received concise specialist brief without polluting main context." });
    };

    const registry = new ToolRegistry();
    for (const tool of createOpenApiTools(() => openApiIndex)) registry.register(tool);
    for (const tool of createCoreHarnessTools({
      skills,
      registry,
      subagentRuntime: { model: MOCK_MODEL, streamFn: specialistStream }
    })) {
      registry.register(tool);
    }

    const runtime = new AgentHarnessRuntime({
      model: MOCK_MODEL,
      streamFn: leadStream,
      store,
      registry,
      skills,
      enableReviewer: false
    });

    const snapshot = await runtime.start({
      title: "Multi-agent specialist test",
      goal: "Inspect shipping API via specialist subagent.",
      kind: "general",
      environment: "sandbox"
    });

    assert.equal(snapshot.metrics.subagentCalls, 1);
    assert.ok(snapshot.spans.some((span) => span.kind === "subagent_specialist"));
    assert.ok(snapshot.evidence.some((item) => item.kind === "specialist_brief"));
    assert.ok(snapshot.evidence.some((item) => item.kind === "openapi_search"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("MCP server exposes controlled OpenAPI search and verifiable evidence reading", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "a-pidoc-mcp-"));
  try {
    const server = createApidocMcpServer({
      openApiDocument: buildDemoOpenApiSpec("http://127.0.0.1:3000"),
      allowedHosts: ["127.0.0.1"],
      allowedPorts: [3000],
      runsDir: join(tempRoot, "mcp-runs")
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    const client = new Client({ name: "test-mcp-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const toolsList = await client.listTools();
    const names = toolsList.tools.map((t) => t.name);
    assert.ok(names.includes("search_openapi"));
    assert.ok(names.includes("execute_http"));
    assert.ok(names.includes("read_evidence"));

    const searchResult = await client.callTool({
      name: "search_openapi",
      arguments: { query: "orders", limit: 3 }
    });
    const contentBlocks = searchResult.content as Array<{ type: string; text?: string }>;
    const payload = JSON.parse(contentBlocks[0]?.text ?? "{}") as { evidenceId?: string };
    assert.ok(payload.evidenceId);

    const evidenceResult = await client.callTool({
      name: "read_evidence",
      arguments: { evidenceId: payload.evidenceId }
    });
    const evBlocks = evidenceResult.content as Array<{ type: string; text?: string }>;
    const artifact = JSON.parse(evBlocks[0]?.text ?? "{}") as { sha256?: string };
    assert.match(artifact.sha256 ?? "", /^[a-f0-9]{64}$/);

    await client.close();
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
