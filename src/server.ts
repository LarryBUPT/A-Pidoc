import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { createFixtureApp, createRealApp } from "./app.js";
import { getCase } from "./fixtures/cases.js";
import { parseRealDebugInput } from "./input/debug-input.js";
import type { RealHttpToolOptions } from "./tools/real-http-tool.js";

export interface ApiServerOptions extends RealHttpToolOptions {
  maxRequestBytes?: number;
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error(`Request exceeds ${limit} byte limit`);
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createApiServer(options: ApiServerOptions = {}): Server {
  const maxRequestBytes = options.maxRequestBytes ?? 1_000_000;
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/debug") {
      try {
        const input = await readJson(request, maxRequestBytes) as Record<string, unknown>;
        if (typeof input.caseId === "string" && input.kind === undefined) {
          const caseData = getCase(input.caseId);
          const report = await createFixtureApp(caseData).run(caseData, {
            expectedRootCause: caseData.expectedRootCause
          });
          response.statusCode = report.status === "blocked" ? 400 : 200;
          response.end(JSON.stringify(report, null, 2));
          return;
        }
        const parsed = parseRealDebugInput(input);
        if (parsed.schemaIssues.length > 0) {
          response.statusCode = 422;
          response.end(JSON.stringify({ error: "request body does not match OpenAPI schema", issues: parsed.schemaIssues }));
          return;
        }
        const report = await createRealApp(options).run(parsed.task);
        response.statusCode = report.status === "blocked" ? 400 : 200;
        response.end(JSON.stringify(report, null, 2));
        return;
      } catch (error) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid request" }));
        return;
      }
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
}

function configuredHosts(): string[] {
  return (process.env.A_PIDOC_ALLOWED_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  createApiServer({ allowedHosts: configuredHosts() })
    .listen(port, "127.0.0.1", () => console.log(`API Doctor listening on http://127.0.0.1:${port}`));
}
