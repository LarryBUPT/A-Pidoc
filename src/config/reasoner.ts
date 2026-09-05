import { getEnvApiKey, getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { DeterministicReasoner } from "../agent/deterministic-reasoner.js";
import { PiReasoner } from "../agent/pi-reasoner.js";
import type { Reasoner } from "../domain/types.js";

export type ReasonerMode = "deterministic" | "pi";

export const DEFAULT_PI_PROVIDER: KnownProvider = "deepseek";
export const DEFAULT_PI_MODEL = "deepseek-v4-pro";

function boundedInteger(value: string | undefined, fallback: number, name: string, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function createConfiguredReasoner(env: NodeJS.ProcessEnv = process.env): Reasoner {
  const mode = (env.A_PIDOC_REASONER ?? "deterministic").toLowerCase();
  if (mode === "deterministic") return new DeterministicReasoner();
  if (mode !== "pi") throw new Error("A_PIDOC_REASONER must be deterministic or pi");

  const provider = env.A_PIDOC_PI_PROVIDER?.trim() || DEFAULT_PI_PROVIDER;
  const modelId = env.A_PIDOC_PI_MODEL?.trim() || DEFAULT_PI_MODEL;
  const model = getModels(provider as KnownProvider).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown Pi model ${provider}/${modelId}`);

  const apiKey = env.A_PIDOC_PI_API_KEY ?? getEnvApiKey(provider);
  if (!apiKey) {
    throw new Error(`Pi mode requires A_PIDOC_PI_API_KEY or a provider credential for ${provider}`);
  }
  const fallbackMode = (env.A_PIDOC_PI_FALLBACK ?? "none").toLowerCase();
  if (fallbackMode !== "none" && fallbackMode !== "deterministic") {
    throw new Error("A_PIDOC_PI_FALLBACK must be none or deterministic");
  }
  const timeoutMs = boundedInteger(env.A_PIDOC_PI_TIMEOUT_MS, 30_000, "A_PIDOC_PI_TIMEOUT_MS", 100, 300_000);
  const maxOutputTokens = boundedInteger(env.A_PIDOC_PI_MAX_OUTPUT_TOKENS, 2_048, "A_PIDOC_PI_MAX_OUTPUT_TOKENS", 256, 4_096);
  const maxPromptBytes = boundedInteger(env.A_PIDOC_PI_MAX_PROMPT_BYTES, 32_768, "A_PIDOC_PI_MAX_PROMPT_BYTES", 1_024, 262_144);
  return new PiReasoner({
    model,
    apiKey,
    timeoutMs,
    maxOutputTokens,
    maxPromptBytes,
    ...(fallbackMode === "deterministic" ? { fallback: new DeterministicReasoner() } : {})
  });
}
