import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import type {
  ApiSpec,
  Diagnosis,
  FixAction,
  KnowledgeRule,
  Reasoner,
  RootCause
} from "../domain/types.js";
import { isSensitiveKey, redactRequest, redactValue, REDACTED } from "../security/redaction.js";
import { DEBUG_AGENT_PROMPT_VERSION, DEBUG_AGENT_SYSTEM_PROMPT } from "./prompts/debug-agent.js";

const ROOT_CAUSES = new Set<RootCause>([
  "AUTH_HEADER_FORMAT",
  "CONTENT_TYPE_MISMATCH",
  "BODY_TYPE_MISMATCH",
  "HTTP_METHOD_MISMATCH",
  "RATE_LIMIT_TRANSIENT",
  "NONE",
  "UNKNOWN"
]);

const EXPECTED_CAUSE = new Map<number, RootCause>([
  [401, "AUTH_HEADER_FORMAT"],
  [405, "HTTP_METHOD_MISMATCH"],
  [415, "CONTENT_TYPE_MISMATCH"],
  [422, "BODY_TYPE_MISMATCH"],
  [429, "RATE_LIMIT_TRANSIENT"]
]);

export class PiReasonerError extends Error {
  constructor(message: string) {
    super(`Pi Reasoner: ${message}`);
    this.name = "PiReasonerError";
  }
}

export interface PiReasonerOptions {
  model: Model<any>;
  apiKey?: string;
  streamFn?: StreamFn;
  fallback?: Reasoner;
  timeoutMs?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PiReasonerError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new PiReasonerError(`${label} contains unsupported keys: ${extras.join(", ")}`);
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new PiReasonerError("model output is not valid JSON");
  }
}

function parseAction(value: unknown, spec: ApiSpec, status: number): FixAction {
  const action = object(value, "action");
  const kind = action.kind;
  if (kind === "stop") {
    onlyKeys(action, ["kind"], "action");
    return { kind };
  }
  if (kind === "retry") {
    onlyKeys(action, ["kind"], "action");
    if (status !== 429) throw new PiReasonerError("retry is only allowed for HTTP 429");
    return { kind };
  }
  if (kind === "set_method") {
    onlyKeys(action, ["kind", "value"], "action");
    if (action.value !== spec.method) throw new PiReasonerError("set_method must use the API specification method");
    return { kind, value: spec.method };
  }
  if (kind === "set_header") {
    onlyKeys(action, ["kind", "name", "value"], "action");
    if (typeof action.name !== "string" || typeof action.value !== "string") {
      throw new PiReasonerError("set_header requires string name and value");
    }
    const name = action.name;
    if (isSensitiveKey(name)) throw new PiReasonerError("sensitive header changes are forbidden");
    const expected = Object.entries(spec.requiredHeaders).find(([candidate]) => candidate.toLowerCase() === name.toLowerCase());
    if (!expected || action.value !== expected[1]) {
      throw new PiReasonerError("set_header must match a non-sensitive API specification header");
    }
    return { kind, name: expected[0], value: expected[1] };
  }
  if (kind === "set_body") {
    onlyKeys(action, ["kind", "name", "value"], "action");
    if (typeof action.name !== "string" || isSensitiveKey(action.name)) {
      throw new PiReasonerError("set_body requires a non-sensitive field name");
    }
    const expectedType = spec.requiredBody[action.name];
    if (!expectedType || typeof action.value !== expectedType) {
      throw new PiReasonerError("set_body must match a required field and its specified type");
    }
    return { kind, name: action.name, value: action.value };
  }
  throw new PiReasonerError("unknown or missing action kind");
}

function parseDiagnosis(text: string, spec: ApiSpec, status: number): Omit<Diagnosis, "evidence"> {
  const value = object(parseJson(text), "diagnosis");
  onlyKeys(value, ["rootCause", "summary", "action"], "diagnosis");
  if (typeof value.rootCause !== "string" || !ROOT_CAUSES.has(value.rootCause as RootCause)) {
    throw new PiReasonerError("unknown rootCause");
  }
  const rootCause = value.rootCause as RootCause;
  const expected = EXPECTED_CAUSE.get(status) ?? "UNKNOWN";
  if (rootCause !== expected) {
    throw new PiReasonerError(`rootCause must be ${expected} for HTTP ${status}`);
  }
  if (typeof value.summary !== "string" || value.summary.trim().length === 0 || value.summary.length > 500) {
    throw new PiReasonerError("summary must contain 1-500 characters");
  }
  return {
    rootCause,
    summary: value.summary.trim(),
    action: parseAction(value.action, spec, status)
  };
}

function localEvidence(status: number, body: unknown, spec: ApiSpec, rules: KnowledgeRule[]): Diagnosis["evidence"] {
  return [
    { source: "http_response", detail: `HTTP ${status}: ${JSON.stringify(redactValue(body))}` },
    {
      source: "api_spec",
      detail: `规范要求 HTTP ${spec.method}；headers=${Object.keys(spec.requiredHeaders).join(",") || "none"}；body=${Object.keys(spec.requiredBody).join(",") || "none"}。`
    },
    ...rules.map((rule) => ({ source: "knowledge_rule" as const, detail: `${rule.id}: ${rule.guidance}` }))
  ];
}

function assistantText(agent: Agent): string {
  const message = [...agent.state.messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.role !== "assistant") throw new PiReasonerError("model returned no assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new PiReasonerError(message.errorMessage ?? `model stopped with ${message.stopReason}`);
  }
  return message.content.map((item) => item.type === "text" ? item.text : "").join("");
}

export class PiReasoner implements Reasoner {
  readonly runtime;
  private readonly timeoutMs: number;

  constructor(private readonly options: PiReasonerOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 300_000) {
      throw new PiReasonerError("timeoutMs must be an integer between 100 and 300000");
    }
    this.runtime = {
      mode: "pi" as const,
      provider: options.model.provider,
      model: options.model.id,
      promptVersion: DEBUG_AGENT_PROMPT_VERSION,
      timeoutMs: this.timeoutMs,
      fallback: options.fallback ? "deterministic" as const : "none" as const
    };
  }

  async diagnose(input: Parameters<Reasoner["diagnose"]>[0]): Promise<Diagnosis> {
    try {
      const safeSpec = {
        method: input.spec.method,
        requiredHeaders: Object.fromEntries(Object.entries(input.spec.requiredHeaders).map(([name, value]) => [
          name,
          isSensitiveKey(name) ? REDACTED : value
        ])),
        requiredBody: input.spec.requiredBody
      };
      const prompt = JSON.stringify({
        promptVersion: DEBUG_AGENT_PROMPT_VERSION,
        request: redactRequest(input.request),
        response: {
          status: input.result.status,
          body: redactValue(input.result.body),
          headers: redactValue(input.result.headers)
        },
        apiSpec: safeSpec,
        knowledgeRules: input.rules.map(({ id, statuses, keywords, guidance }) => ({ id, statuses, keywords, guidance }))
      });
      const agent = new Agent({
        initialState: {
          systemPrompt: DEBUG_AGENT_SYSTEM_PROMPT,
          model: this.options.model,
          thinkingLevel: "low",
          tools: []
        },
        ...(this.options.streamFn ? { streamFn: this.options.streamFn } : {}),
        ...(this.options.apiKey ? { getApiKey: () => this.options.apiKey } : {})
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        agent.abort();
      }, this.timeoutMs);
      timer.unref();
      try {
        await agent.prompt(prompt);
      } finally {
        clearTimeout(timer);
      }
      if (timedOut) throw new PiReasonerError(`model timed out after ${this.timeoutMs}ms`);
      const diagnosis = parseDiagnosis(assistantText(agent), input.spec, input.result.status);
      return {
        ...diagnosis,
        evidence: localEvidence(input.result.status, input.result.body, input.spec, input.rules)
      };
    } catch (error) {
      if (!this.options.fallback) throw error;
      const diagnosis = await this.options.fallback.diagnose(input);
      return {
        ...diagnosis,
        evidence: [
          ...diagnosis.evidence,
          { source: "policy", detail: "Pi Agent 失败；已执行显式配置的确定性降级。" }
        ]
      };
    }
  }
}
