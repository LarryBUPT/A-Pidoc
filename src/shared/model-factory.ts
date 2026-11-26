import type { StreamFn } from "@earendil-works/pi-agent-core";
import { getEnvApiKey, getModels, streamSimple, type Model } from "@earendil-works/pi-ai/compat";

export interface ResolvedModelConfig {
  model: Model<any>;
  streamFn: StreamFn;
  apiKey?: string;
}

/**
 * Resolves the Pi LLM model configuration.
 * Defaults to DeepSeek via Pi's native OpenAI-compatible provider,
 * while also supporting custom OpenAI-compatible endpoints via env vars.
 */
export function resolveLiveModel(env: NodeJS.ProcessEnv = process.env): ResolvedModelConfig {
  const provider = (env.A_PIDOC_PROVIDER?.trim() || "deepseek") as Parameters<typeof getModels>[0];
  const requestedModelId = env.A_PIDOC_MODEL?.trim() || "deepseek-chat";
  const apiKey = env.A_PIDOC_API_KEY?.trim() || env.DEEPSEEK_API_KEY?.trim() || getEnvApiKey(provider);

  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider}". Set DEEPSEEK_API_KEY or A_PIDOC_API_KEY in .env.`
    );
  }

  const knownModels = getModels(provider);
  const matched = knownModels.find((candidate) => candidate.id === requestedModelId);

  if (matched) {
    return { model: matched, streamFn: streamSimple, apiKey };
  }

  // DeepSeek official API exposes `deepseek-chat` and `deepseek-reasoner` on the same endpoint.
  // If pi-ai's static catalog uses a newer alias (e.g. deepseek-v4-flash), clone its transport
  // metadata so standard DeepSeek model IDs work seamlessly.
  const baseTemplate = knownModels[0];
  if (baseTemplate) {
    const customModel: Model<any> = {
      ...baseTemplate,
      id: requestedModelId,
      name: requestedModelId,
      baseUrl: env.A_PIDOC_BASE_URL?.trim() || baseTemplate.baseUrl,
      contextWindow: 64_000,
      maxTokens: 8_192
    };
    return { model: customModel, streamFn: streamSimple, apiKey };
  }

  throw new Error(`Unsupported Pi provider "${provider}"`);
}
