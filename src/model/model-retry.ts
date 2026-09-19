export interface ModelRetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxTotalWaitMs: number;
  jitterRatio: number;
}

export type ModelRetryReason =
  | "http_429"
  | "http_502"
  | "http_503"
  | "http_504"
  | "provider_retryable"
  | "deadline"
  | `network_${string}`;

export type ModelRetryEvent =
  | { type: "initial_request"; attempt: 1 }
  | { type: "retry_scheduled"; attempt: number; reason: ModelRetryReason; delayMs: number; retryAfterMs?: number }
  | { type: "retry_attempt"; attempt: number; reason: ModelRetryReason }
  | { type: "retry_exhausted"; attempt: number; reason: ModelRetryReason; limit: "attempts" | "single_wait" }
  | { type: "budget_exhausted"; attempt: number; reason: ModelRetryReason; budget: "duration" | "total_wait"; requiredWaitMs: number; remainingMs: number };

export interface ModelRetryOptions {
  policy?: Partial<ModelRetryPolicy>;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onEvent?: (event: ModelRetryEvent) => void | Promise<void>;
}

export const DEFAULT_MODEL_RETRY_POLICY: Readonly<ModelRetryPolicy> = Object.freeze({
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
  maxTotalWaitMs: 4_000,
  jitterRatio: 0.2
});

const TRANSIENT_STATUS = new Set([429, 502, 503, 504]);
const TERMINAL_STATUS = new Set([400, 401, 403, 404, 422]);
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET"
]);

export class ModelRetryBudgetError extends Error {
  constructor() {
    super("MODEL_RETRY_BUDGET_EXHAUSTED");
    this.name = "ModelRetryBudgetError";
  }
}

function policy(overrides?: Partial<ModelRetryPolicy>, maxRetries?: number): ModelRetryPolicy {
  const value = { ...DEFAULT_MODEL_RETRY_POLICY, ...overrides };
  if (maxRetries !== undefined) value.maxRetries = Math.min(value.maxRetries, Math.max(0, maxRetries));
  if (!Number.isSafeInteger(value.maxRetries) || value.maxRetries < 0 ||
      !Number.isFinite(value.baseDelayMs) || value.baseDelayMs < 0 ||
      !Number.isFinite(value.maxDelayMs) || value.maxDelayMs < 0 ||
      !Number.isFinite(value.maxTotalWaitMs) || value.maxTotalWaitMs < 0 ||
      !Number.isFinite(value.jitterRatio) || value.jitterRatio < 0 || value.jitterRatio > 1) {
    throw new Error("INVALID_MODEL_RETRY_POLICY");
  }
  return value;
}

function abortError(): Error {
  const error = new Error("Request aborted");
  error.name = "AbortError";
  return error;
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") return record.code.toUpperCase();
    current = record.cause;
  }
  return undefined;
}

function networkReason(error: unknown): ModelRetryReason | undefined {
  const code = errorCode(error);
  return code && TRANSIENT_NETWORK_CODES.has(code) ? `network_${code}` : undefined;
}

function responseReason(response: Response): ModelRetryReason | undefined {
  if (TERMINAL_STATUS.has(response.status)) return undefined;
  const explicit = response.headers.get("x-should-retry")?.toLowerCase();
  if (explicit === "false") return undefined;
  if (TRANSIENT_STATUS.has(response.status)) return `http_${response.status}` as ModelRetryReason;
  return explicit === "true" ? "provider_retryable" : undefined;
}

export function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const milliseconds = headers.get("retry-after-ms")?.trim();
  if (milliseconds && /^\d+(?:\.\d+)?$/.test(milliseconds)) return Math.max(0, Math.ceil(Number(milliseconds)));
  const value = headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Math.max(0, Math.ceil(Number(value) * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowMs) : undefined;
}

export function exponentialDelayMs(retryNumber: number, value: ModelRetryPolicy, random: () => number): number {
  const exponential = Math.min(value.maxDelayMs, value.baseDelayMs * 2 ** Math.max(0, retryNumber - 1));
  const rawSample = random();
  const sample = Number.isFinite(rawSample) ? Math.min(1, Math.max(0, rawSample)) : 0.5;
  const jittered = exponential * (1 - value.jitterRatio + 2 * value.jitterRatio * sample);
  return Math.min(value.maxDelayMs, Math.max(0, Math.round(jittered)));
}

function replayableBody(body: BodyInit | null | undefined): boolean {
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

function withBudgetSignal(init: RequestInit | undefined, outer: AbortSignal | undefined, remainingMs: number): RequestInit {
  const signals = [init?.signal, outer].filter((signal): signal is AbortSignal => !!signal);
  if (Number.isFinite(remainingMs)) signals.push(AbortSignal.timeout(Math.max(1, Math.ceil(remainingMs))));
  const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  return { ...init, ...(signal ? { signal } : {}) };
}

export function createRetryingModelFetch(options: ModelRetryOptions & {
  deadlineMs: number;
  signal?: AbortSignal;
  maxRetries?: number;
}): typeof globalThis.fetch {
  const retryPolicy = policy(options.policy, options.maxRetries);
  const baseFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const emit = async (event: ModelRetryEvent) => { await options.onEvent?.(event); };

  return async (input, init) => {
    const requestTemplate = typeof Request !== "undefined" && input instanceof Request ? input.clone() : undefined;
    const mayRetry = replayableBody(init?.body ?? requestTemplate?.body);
    let attempt = 1;
    let totalWaitMs = 0;
    await emit({ type: "initial_request", attempt: 1 });

    for (;;) {
      const remainingBeforeRequest = options.deadlineMs - now();
      if (remainingBeforeRequest <= 0) {
        await emit({ type: "budget_exhausted", attempt, reason: "deadline", budget: "duration", requiredWaitMs: 0, remainingMs: 0 });
        throw new ModelRetryBudgetError();
      }
      if (options.signal?.aborted || init?.signal?.aborted) throw abortError();
      const attemptInput = requestTemplate ? requestTemplate.clone() : input;
      try {
        const response = await baseFetch(attemptInput, withBudgetSignal(init, options.signal, remainingBeforeRequest));
        const reason = mayRetry ? responseReason(response) : undefined;
        if (!reason) return response;
        if (attempt >= retryPolicy.maxRetries + 1) {
          await emit({ type: "retry_exhausted", attempt, reason, limit: "attempts" });
          return response;
        }
        const retryAfterMs = parseRetryAfterMs(response.headers, now());
        const delayMs = retryAfterMs ?? exponentialDelayMs(attempt, retryPolicy, random);
        if (delayMs > retryPolicy.maxDelayMs) {
          await emit({ type: "retry_exhausted", attempt, reason, limit: "single_wait" });
          return response;
        }
        const remainingMs = Math.max(0, options.deadlineMs - now());
        if (totalWaitMs + delayMs > retryPolicy.maxTotalWaitMs || delayMs >= remainingMs) {
          await emit({ type: "budget_exhausted", attempt, reason, budget: totalWaitMs + delayMs > retryPolicy.maxTotalWaitMs ? "total_wait" : "duration", requiredWaitMs: delayMs, remainingMs });
          return response;
        }
        await response.body?.cancel().catch(() => undefined);
        await emit({ type: "retry_scheduled", attempt: attempt + 1, reason, delayMs, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
        await sleep(delayMs, options.signal ?? init?.signal ?? undefined);
        totalWaitMs += delayMs;
        attempt++;
        await emit({ type: "retry_attempt", attempt, reason });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          if (now() >= options.deadlineMs) await emit({ type: "budget_exhausted", attempt, reason: "deadline", budget: "duration", requiredWaitMs: 0, remainingMs: 0 });
          throw error;
        }
        if (options.signal?.aborted || init?.signal?.aborted) throw error;
        const reason = mayRetry ? networkReason(error) : undefined;
        if (!reason) throw error;
        if (attempt >= retryPolicy.maxRetries + 1) {
          await emit({ type: "retry_exhausted", attempt, reason, limit: "attempts" });
          throw error;
        }
        const delayMs = exponentialDelayMs(attempt, retryPolicy, random);
        const remainingMs = Math.max(0, options.deadlineMs - now());
        if (totalWaitMs + delayMs > retryPolicy.maxTotalWaitMs || delayMs >= remainingMs) {
          await emit({ type: "budget_exhausted", attempt, reason, budget: totalWaitMs + delayMs > retryPolicy.maxTotalWaitMs ? "total_wait" : "duration", requiredWaitMs: delayMs, remainingMs });
          throw error;
        }
        await emit({ type: "retry_scheduled", attempt: attempt + 1, reason, delayMs });
        await sleep(delayMs, options.signal ?? init?.signal ?? undefined);
        totalWaitMs += delayMs;
        attempt++;
        await emit({ type: "retry_attempt", attempt, reason });
      }
    }
  };
}
