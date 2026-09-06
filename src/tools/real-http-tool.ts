import type { ApiRequest, HttpResult, HttpTool } from "../domain/types.js";
import { RequestPolicy } from "../security/request-policy.js";
import { isSensitiveKey, redactValue } from "../security/redaction.js";
import { PublicError } from "../security/errors.js";

async function readLimitedBody(response: Response, limit: number): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > limit) {
    throw new Error(`Response exceeds ${limit} byte limit`);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`Response exceeds ${limit} byte limit`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export interface RealHttpToolOptions {
  allowedHosts?: Iterable<string>;
  allowedPorts?: Iterable<number>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class RealHttpTool implements HttpTool {
  private readonly policy: RequestPolicy;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: RealHttpToolOptions = {}) {
    this.policy = new RequestPolicy({
      allowedHosts: options.allowedHosts ?? ["localhost", "127.0.0.1"],
      ...(options.allowedPorts ? { allowedPorts: options.allowedPorts } : {})
    });
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_000_000;
  }

  async execute(request: ApiRequest): Promise<HttpResult> {
    try { await this.policy.assertResolvedAddressAllowed(request); } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError("NETWORK_ERROR", "HTTP address resolution failed", 502);
    }
    const started = performance.now();
    let response: Response;
    try { response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error"
    }); } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new PublicError("REQUEST_TIMEOUT", "HTTP timeout", 504);
      throw new PublicError("NETWORK_ERROR", "HTTP connection failed", 502);
    }
    let raw: string;
    try { raw = await readLimitedBody(response, this.maxResponseBytes); } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) throw new PublicError("REQUEST_TIMEOUT", "HTTP response timeout", 504);
      throw error;
    }
    let parsed: unknown = raw;
    let errorType: HttpResult["errorType"];
    if (raw && /(?:application\/json|\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = raw;
        errorType = "INVALID_JSON_RESPONSE";
      }
    }
    const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (redactValue(parsed) as Record<string, unknown>)
      : { data: redactValue(parsed) };
    const headers = Object.fromEntries(
      [...response.headers.entries()].map(([key, value]) => [key, isSensitiveKey(key) ? "[REDACTED]" : value])
    );
    return {
      status: response.status,
      body,
      headers,
      durationMs: Math.max(1, Math.round(performance.now() - started)),
      ...(errorType ? { errorType } : {})
    };
  }
}
