import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createFixtureApp, createRealAppWithReasoner } from "./app.js";
import { createConfiguredReasoner } from "./config/reasoner.js";
import type { Reasoner } from "./domain/types.js";
import { getCase } from "./fixtures/cases.js";
import { parseRealDebugInput } from "./input/debug-input.js";
import type { RealHttpToolOptions } from "./tools/real-http-tool.js";
import { PublicError, safeError } from "./security/errors.js";

export interface ApiServerOptions extends RealHttpToolOptions {
  maxRequestBytes?: number;
  reasoner?: Reasoner;
  apiToken?: string;
  allowedOrigins?: Iterable<string>;
  rateLimit?: number;
  rateWindowMs?: number;
  maxConcurrent?: number;
}

interface RateEntry { count: number; resetAt: number }

function send(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.statusCode = status;
  response.end(JSON.stringify(body, null, 2));
}

function tokenMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
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
  const reasoner = options.reasoner ?? createConfiguredReasoner();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const rateLimit = options.rateLimit ?? 30;
  const rateWindowMs = options.rateWindowMs ?? 60_000;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const rates = new Map<string, RateEntry>();
  let active = 0;
  if (options.apiToken !== undefined && options.apiToken.length < 16) {
    throw new PublicError("WEAK_API_TOKEN", "A_PIDOC_API_TOKEN must contain at least 16 characters");
  }
  if (!Number.isInteger(rateLimit) || rateLimit < 1 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new PublicError("INVALID_SERVER_LIMIT", "rateLimit and maxConcurrent must be positive integers");
  }
  return createServer(async (request, response) => {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.method === "GET" && request.url === "/health") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/debug") {
      const origin = request.headers.origin;
      if (origin && !allowedOrigins.has(origin)) {
        send(response, 403, { code: "ORIGIN_FORBIDDEN", error: "Browser origin is not allowed" });
        return;
      }
      if (options.apiToken && !tokenMatches(request.headers.authorization, options.apiToken)) {
        response.setHeader("www-authenticate", "Bearer");
        send(response, 401, { code: "UNAUTHORIZED", error: "Valid Bearer token required" });
        return;
      }
      const client = request.socket.remoteAddress ?? "unknown";
      const now = Date.now();
      const previous = rates.get(client);
      const entry = !previous || previous.resetAt <= now ? { count: 0, resetAt: now + rateWindowMs } : previous;
      entry.count += 1;
      rates.set(client, entry);
      if (entry.count > rateLimit) {
        response.setHeader("retry-after", String(Math.max(1, Math.ceil((entry.resetAt - now) / 1_000))));
        send(response, 429, { code: "RATE_LIMITED", error: "Request rate limit exceeded" });
        return;
      }
      if (active >= maxConcurrent) {
        send(response, 429, { code: "CONCURRENCY_LIMITED", error: "Too many concurrent debug requests" });
        return;
      }
      active += 1;
      try {
        const input = await readJson(request, maxRequestBytes) as Record<string, unknown>;
        if (typeof input.caseId === "string" && input.kind === undefined) {
          const caseData = getCase(input.caseId);
          const report = await createFixtureApp(caseData).run(caseData, {
            expectedRootCause: caseData.expectedRootCause
          });
          send(response, report.status === "blocked" ? 400 : 200, report);
          return;
        }
        const parsed = parseRealDebugInput(input);
        if (parsed.schemaIssues.length > 0) {
          send(response, 422, { code: "SCHEMA_MISMATCH", error: "request body does not match OpenAPI schema", issues: parsed.schemaIssues });
          return;
        }
        const report = await createRealAppWithReasoner(options, reasoner).run(parsed.task);
        send(response, report.status === "blocked" ? 400 : 200, report);
        return;
      } catch (error) {
        const safe = safeError(error);
        const clientSafe = safe.code === "INTERNAL_ERROR"
          ? { code: "INVALID_REQUEST", message: "Invalid debug request", httpStatus: 400 }
          : safe;
        send(response, clientSafe.httpStatus, { code: clientSafe.code, error: clientSafe.message });
        return;
      } finally {
        active -= 1;
      }
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
}

export function assertSafeBind(host: string, apiToken: string | undefined): void {
  const normalized = host.toLowerCase();
  const loopback = normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
  if (!loopback && !apiToken) {
    throw new PublicError("PUBLIC_BIND_REQUIRES_AUTH", "Non-loopback binding requires A_PIDOC_API_TOKEN");
  }
}

function configuredHosts(): string[] {
  return (process.env.A_PIDOC_ALLOWED_HOSTS ?? "localhost,127.0.0.1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
}

function configuredPorts(): number[] {
  return (process.env.A_PIDOC_ALLOWED_PORTS ?? "80,443")
    .split(",")
    .map((port) => Number(port.trim()))
    .filter((port) => Number.isInteger(port));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.A_PIDOC_BIND_HOST ?? "127.0.0.1";
  const apiToken = process.env.A_PIDOC_API_TOKEN;
  assertSafeBind(host, apiToken);
  createApiServer({
    allowedHosts: configuredHosts(),
    allowedPorts: configuredPorts(),
    ...(apiToken ? { apiToken } : {})
  }).listen(port, host, () => console.log(`API Doctor listening on http://${host}:${port}`));
}
