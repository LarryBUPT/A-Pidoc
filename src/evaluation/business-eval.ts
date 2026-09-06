import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";
import { createRealApp } from "../app.js";
import { businessCases } from "./business-cases.js";

export async function evaluateBusinessCases() {
  const counts = new Map<string, number>();
  const server = createServer(async (request, response) => {
    const id = request.url?.slice(1) ?? "";
    const item = businessCases.find((candidate) => candidate.id === id);
    if (!item) { response.writeHead(404).end(); return; }
    const count = (counts.get(id) ?? 0) + 1;
    counts.set(id, count);
    if (item.failure.transport === "disconnect") { request.socket.destroy(); return; }
    if (item.failure.transport === "timeout") return; // Client timeout owns cancellation; no delayed server write.
    response.setHeader("content-type", "application/json");
    if (item.failure.transport === "invalid-json") { response.end("{broken"); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = raw ? JSON.parse(raw) : null;
    const expected = { ...item.request, ...item.repaired };
    const matches = item.repaired !== undefined && count > 1 && request.method === expected.method &&
      isDeepStrictEqual(body, expected.body) && Object.entries(expected.headers).every(([key, value]) => request.headers[key.toLowerCase()] === value);
    response.statusCode = matches ? 200 : item.failure.status;
    if (item.failure.retryAfter !== undefined) response.setHeader("retry-after", item.failure.retryAfter);
    response.end(JSON.stringify(matches ? { ok: true } : item.failure.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Evaluation server has no port");
  const results = [];
  try {
    for (const item of businessCases) {
      const started = performance.now();
      const report = await createRealApp({ allowedHosts: ["127.0.0.1"], allowedPorts: [address.port], timeoutMs: item.failure.transport === "timeout" ? 30 : 2_000 }).run({
        id: item.id, title: item.title, source: "curl", request: { ...structuredClone(item.request), url: `http://127.0.0.1:${address.port}/${item.id}` }, spec: item.spec
      });
      const rootCauseMatched = report.rootCause === item.expected.rootCause;
      const outcomeMatched = report.status === item.expected.status && report.attempts.length === item.expected.attempts;
      const unsafeMutation = item.repaired === undefined && !isDeepStrictEqual(report.originalRequest, report.finalRequest);
      results.push({ id: item.id, rootCause: report.rootCause, expectedRootCause: item.expected.rootCause, status: report.status, attempts: report.attempts.length,
        passed: rootCauseMatched && outcomeMatched && !unsafeMutation && report.evaluation.evidenceComplete,
        rootCauseMatched, outcomeMatched, unsafeMutation, durationMs: Math.round(performance.now() - started),
        evidenceComplete: report.evaluation.evidenceComplete });
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const durations = results.map((r) => r.durationMs).sort((a, b) => a - b);
  return { datasetVersion: "v1.0.0", mode: "local-http-deterministic", total: results.length,
    passed: results.filter((r) => r.passed).length, faultCategories: new Set(businessCases.map((c) => c.expected.rootCause).filter((cause) => cause !== "NONE")).size,
    rootCauseAccuracy: results.filter((r) => r.rootCauseMatched).length / results.length,
    resolvedRate: results.filter((r) => r.status === "resolved").length / results.length,
    unsafeMutations: results.filter((r) => r.unsafeMutation).length,
    averageAttempts: results.reduce((sum, r) => sum + r.attempts, 0) / results.length,
    p95DurationMs: durations[Math.ceil(results.length * 0.95) - 1], modelCalls: 0, modelCostUsd: 0, results };
}
