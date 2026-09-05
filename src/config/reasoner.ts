import { getEnvApiKey, getModels, type KnownProvider } from "@earendil-works/pi-ai";
import { DeterministicReasoner } from "../agent/deterministic-reasoner.js";
import { PiReasoner } from "../agent/pi-reasoner.js";
import type { Reasoner } from "../domain/types.js";

export type ReasonerMode = "deterministic" | "pi";

export function createConfiguredReasoner(env: NodeJS.ProcessEnv = process.env): Reasoner {
  const mode = (env.A_PIDOC_REASONER ?? "deterministic").toLowerCase();
  if (mode === "deterministic") return new DeterministicReasoner();
  if (mode !== "pi") throw new Error("A_PIDOC_REASONER must be deterministic or pi");

  const provider = env.A_PIDOC_PI_PROVIDER?.trim();
  const modelId = env.A_PIDOC_PI_MODEL?.trim();
  if (!provider || !modelId) {
    throw new Error("Pi mode requires A_PIDOC_PI_PROVIDER and A_PIDOC_PI_MODEL");
  }
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
  const timeoutMs = Number(env.A_PIDOC_PI_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) {
    throw new Error("A_PIDOC_PI_TIMEOUT_MS must be an integer between 100 and 300000");
  }
  return new PiReasoner({
    model,
    apiKey,
    timeoutMs,
    ...(fallbackMode === "deterministic" ? { fallback: new DeterministicReasoner() } : {})
  });
}
