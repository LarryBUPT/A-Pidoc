import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { SessionStore } from "../kernel/session-store.js";
import { TelemetryCollector } from "../kernel/telemetry.js";
import { createEmptyMetrics, DEFAULT_RUN_BUDGET, type RunSnapshot } from "../kernel/types.js";
import { ControlledHttpClient } from "../shared/http-client.js";
import { sha256Digest } from "../shared/digest.js";
import { redactRequest, redactValue } from "../shared/redaction.js";
import type { ApiRequest, EvidenceArtifact, HttpMethod } from "../shared/types.js";
import { OpenApiIndex } from "../tools/openapi-search.js";
import { scanRepositoryCalls } from "../tools/workspace-tools.js";

export interface McpRuntimeConfig {
  openApiDocument: unknown;
  allowedHosts: string[];
  allowedPorts: number[];
  runsDir?: string;
  timeoutMs?: number;
}

function mcpResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true as const } : {})
  };
}

/**
 * 标准 stdio MCP Server（AI Native 原子能力暴露层）：
 * 让 Cursor / Claude Code / 其他外部 Agent 可以直接安全复用 A-Pidoc 的
 * OpenAPI 精准检索、受控 HTTP 探测、仓库扫描与 SHA-256 证据读取能力。
 */
export function createApidocMcpServer(config: McpRuntimeConfig): McpServer {
  const index = OpenApiIndex.fromRawDocument(config.openApiDocument);
  const httpClient = new ControlledHttpClient({
    allowedHosts: config.allowedHosts,
    allowedPorts: config.allowedPorts,
    ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {})
  });
  const store = new SessionStore(config.runsDir ?? resolve(".private/mcp-runs"));
  const runId = `mcp_${randomUUID().slice(0, 10)}`;

  const snapshot: RunSnapshot = {
    version: 2,
    runId,
    task: {
      id: runId,
      title: `MCP Session (${index.title})`,
      goal: "External MCP client interactive session",
      kind: "api-debug",
      environment: "sandbox",
      budget: DEFAULT_RUN_BUDGET
    },
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    loadedSkills: [],
    messages: [],
    evidence: [],
    approvals: [],
    spans: [],
    compactions: [],
    metrics: createEmptyMetrics(),
    reviewVerdicts: []
  };

  const telemetry = new TelemetryCollector(runId, snapshot.spans, snapshot.metrics, (event) =>
    store.appendEvent(event)
  );

  const recordEvidence = async (
    toolName: string,
    kind: string,
    summary: string,
    rawData: unknown
  ): Promise<EvidenceArtifact> => {
    const safeData = redactValue(rawData);
    const artifact: EvidenceArtifact = {
      id: `${kind}_mcp_${snapshot.evidence.length + 1}`,
      kind,
      toolCallId: `mcp_${randomUUID().slice(0, 8)}`,
      toolName,
      sha256: sha256Digest(safeData),
      createdAt: new Date().toISOString(),
      summary,
      data: safeData
    };
    snapshot.evidence.push(artifact);
    snapshot.metrics.toolCalls += 1;
    telemetry.emit("evidence_recorded", {
      id: artifact.id,
      kind: artifact.kind,
      toolName,
      sha256: artifact.sha256
    });
    await store.saveSnapshot(snapshot);
    return artifact;
  };

  const server = new McpServer(
    { name: "a-pidoc", version: "2.0.0" },
    {
      instructions:
        "Use search_openapi and get_openapi_operation first to inspect the API contract, execute_http to run allowlisted diagnostics, and read_evidence to retrieve full redacted artifacts."
    }
  );

  server.registerTool(
    "search_openapi",
    {
      title: "Search OpenAPI Operations",
      description: "Search the registered OpenAPI spec by keyword, path, method, or field name.",
      inputSchema: z.object({
        query: z.string().max(256).default(""),
        limit: z.number().int().min(1).max(15).default(5)
      })
    },
    async (args) => {
      const matches = index.search(args.query, args.limit);
      const artifact = await recordEvidence(
        "search_openapi",
        "openapi_search",
        `Found ${matches.length} operations`,
        {
          apiTitle: index.title,
          totalOperations: index.operations.length,
          matches: matches.map((m) => ({
            score: m.score,
            operationId: m.operation.operationId,
            method: m.operation.method,
            path: m.operation.path,
            summary: m.operation.summary
          }))
        }
      );
      return mcpResult({ evidenceId: artifact.id, data: artifact.data });
    }
  );

  server.registerTool(
    "get_openapi_operation",
    {
      title: "Get OpenAPI Operation Contract",
      description: "Retrieve detailed headers, parameters, and JSON body schema for one operation.",
      inputSchema: z.object({
        operationIdOrPath: z.string().min(1).max(200),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional()
      })
    },
    async (args) => {
      const op = index.getByIdOrPath(args.operationIdOrPath, args.method);
      if (!op) {
        return mcpResult({ error: `Operation not found: ${args.operationIdOrPath}` }, true);
      }
      const artifact = await recordEvidence(
        "get_openapi_operation",
        "api_operation",
        `Loaded ${op.method} ${op.path}`,
        op
      );
      return mcpResult({ evidenceId: artifact.id, data: artifact.data });
    }
  );

  server.registerTool(
    "execute_http",
    {
      title: "Execute Allowlisted HTTP Request",
      description: "Run a controlled HTTP request under A-Pidoc host/port/SSRF/redaction guardrails.",
      inputSchema: z.object({
        url: z.string().url().max(2_048),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.record(z.string(), z.unknown()).nullable().optional()
      })
    },
    async (args, context) => {
      try {
        const request: ApiRequest = {
          url: args.url,
          method: args.method as HttpMethod,
          headers: args.headers ?? {},
          body: args.body ?? null
        };
        const response = await httpClient.execute(request, context.mcpReq.signal);
        const safeReq = redactRequest(request);
        const artifact = await recordEvidence(
          "execute_http",
          "http_observation",
          `${safeReq.method} ${safeReq.url} -> ${response.status}`,
          { request: safeReq, response }
        );
        return mcpResult({ evidenceId: artifact.id, sha256: artifact.sha256, data: artifact.data });
      } catch (error) {
        return mcpResult(
          { error: error instanceof Error ? error.message : "HTTP execution failed safely" },
          true
        );
      }
    }
  );

  server.registerTool(
    "scan_repository",
    {
      title: "Scan Repository API Calls",
      description: "Read-only scan of Fetch/Axios/Requests/OkHttp client calls inside a local repository path.",
      inputSchema: z.object({
        rootDir: z.string().min(1).max(512)
      })
    },
    async (args) => {
      try {
        const calls = await scanRepositoryCalls(args.rootDir);
        const artifact = await recordEvidence(
          "scan_repository",
          "repository_scan",
          `Scanned ${calls.length} API calls`,
          { rootDir: args.rootDir, totalCalls: calls.length, calls }
        );
        return mcpResult({ evidenceId: artifact.id, data: artifact.data });
      } catch (error) {
        return mcpResult(
          { error: error instanceof Error ? error.message : "Repository scan failed" },
          true
        );
      }
    }
  );

  server.registerTool(
    "read_evidence",
    {
      title: "Read Verifiable Evidence Artifact",
      description: "Read one redacted, integrity-checked Evidence Artifact from the current MCP session.",
      inputSchema: z.object({
        evidenceId: z.string().min(1).max(160)
      })
    },
    async (args) => {
      const artifact = snapshot.evidence.find((item) => item.id === args.evidenceId);
      if (!artifact) {
        return mcpResult({ error: `Evidence not found: ${args.evidenceId}` }, true);
      }
      return mcpResult(artifact);
    }
  );

  return server;
}

export async function startMcpStdioServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const openApiPath = env.A_PIDOC_MCP_OPENAPI;
  if (!openApiPath) {
    throw new Error("A_PIDOC_MCP_OPENAPI environment variable is required");
  }

  const allowedHosts = (env.A_PIDOC_MCP_ALLOWED_HOSTS ?? "127.0.0.1,localhost")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);

  const allowedPorts = (env.A_PIDOC_MCP_ALLOWED_PORTS ?? "80,443,3000,8080")
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port) && port > 0);

  const rawDoc = await readFile(resolve(openApiPath), "utf8");
  const server = createApidocMcpServer({
    openApiDocument: rawDoc,
    allowedHosts,
    allowedPorts
  });

  serveStdio(() => server, {
    onerror: (error) => console.error(`A-Pidoc MCP transport error: ${error.message}`)
  });
  console.error("A-Pidoc v2 MCP server listening on stdio.");
}

const currentEntry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === currentEntry) {
  void startMcpStdioServer().catch((error) => {
    console.error(`MCP startup failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
