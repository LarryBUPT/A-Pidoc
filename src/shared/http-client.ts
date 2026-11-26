import { PublicError } from "./errors.js";
import { isSensitiveKey, REDACTED, redactValue } from "./redaction.js";
import { RequestPolicy } from "./request-policy.js";
import type { ApiRequest, HttpResult } from "./types.js";

export interface HttpClientOptions {
  allowedHosts?: Iterable<string>;
  allowedPorts?: Iterable<number>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolveHost?: (host: string) => Promise<string[]>;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PublicError("RESPONSE_TOO_LARGE", `Response exceeds ${limit} byte limit`, 502);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > limit) {
      await reader.cancel();
      throw new PublicError("RESPONSE_TOO_LARGE", `Response exceeds ${limit} byte limit`, 502);
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * 通用受控 HTTP 客户端：
 * - 执行前强制经过 RequestPolicy（协议 / Host / Port 白名单 + DNS SSRF 私网拦截）
 * - 禁用自动重定向（防止重定向绕过白名单）
 * - 响应体流式限流 + 敏感 Header/Body 字段自动脱敏
 */
export class ControlledHttpClient {
  private readonly policy: RequestPolicy;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: HttpClientOptions = {}) {
    this.policy = new RequestPolicy({
      allowedHosts: options.allowedHosts ?? ["localhost", "127.0.0.1"],
      ...(options.allowedPorts ? { allowedPorts: options.allowedPorts } : {}),
      ...(options.resolveHost ? { resolveHost: options.resolveHost } : {})
    });
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 512_000;
  }

  async execute(request: ApiRequest, signal?: AbortSignal): Promise<HttpResult> {
    try {
      await this.policy.assertResolvedAddressAllowed(request);
    } catch (error) {
      if (error instanceof PublicError) throw error;
      throw new PublicError("NETWORK_ERROR", "HTTP address resolution failed", 502);
    }

    const startedAt = performance.now();
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    let response: Response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === null ? {} : { body: JSON.stringify(request.body) }),
        signal: combinedSignal,
        redirect: "error"
      });
    } catch (error) {
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
        throw new PublicError("REQUEST_TIMEOUT", `HTTP request timed out after ${this.timeoutMs}ms`, 504);
      }
      throw new PublicError("NETWORK_ERROR", "HTTP connection failed", 502);
    }

    const rawText = await readBoundedText(response, this.maxResponseBytes);
    const contentType = response.headers.get("content-type") ?? "";
    let parsed: unknown = rawText;
    let errorType: HttpResult["errorType"];

    if (rawText && /(?:application\/json|\+json)(?:\s*;|$)/i.test(contentType)) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = rawText;
        errorType = "INVALID_JSON_RESPONSE";
      }
    }

    const body =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (redactValue(parsed) as Record<string, unknown>)
        : { data: redactValue(parsed) };

    const headers = Object.fromEntries(
      [...response.headers.entries()].map(([key, value]) => [
        key,
        isSensitiveKey(key) ? REDACTED : value
      ])
    );

    return {
      status: response.status,
      headers,
      body,
      durationMs: Math.max(1, Math.round(performance.now() - startedAt)),
      ...(errorType ? { errorType } : {})
    };
  }
}
