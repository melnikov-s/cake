import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { ModelOption } from "../ipc/session-contract";
import { supportsFastMode } from "./fast-mode";

/**
 * Enumerates every provider's models with authentication state. Only needs a
 * ModelRuntime, so it works without a live Pi session — used both by runtime
 * snapshots and by the session-less model catalog request.
 */
export async function listModelOptions(modelRuntime: ModelRuntime): Promise<ModelOption[]> {
  const providers = modelRuntime.getProviders();
  const authentication = new Map(
    await Promise.all(
      providers.map(
        async (provider) => [provider.id, await modelRuntime.checkAuth(provider.id)] as const,
      ),
    ),
  );
  return providers.flatMap((provider) =>
    provider
      .getModels()
      .filter((model) => provider.id.length <= 256 && model.id.length <= 512)
      .map((model) => ({
        provider: provider.id,
        providerName: provider.name,
        id: model.id,
        name: model.name,
        reasoning: model.reasoning,
        availableThinkingLevels: getSupportedThinkingLevels(model),
        fastMode: supportsFastMode({ provider: provider.id, id: model.id }),
        input: model.input,
        authenticated: Boolean(authentication.get(provider.id)),
        authSource: modelRuntime.getProviderAuthStatus(provider.id).source,
        authLabel:
          authentication.get(provider.id)?.source ??
          modelRuntime.getProviderAuthStatus(provider.id).label,
        authTypes: [
          provider.auth.apiKey ? ("api_key" as const) : undefined,
          provider.auth.oauth ? ("oauth" as const) : undefined,
        ].filter((type): type is "api_key" | "oauth" => Boolean(type)),
      })),
  );
}

// The shared agent directory hosts the model catalog, so one cached runtime
// serves every session-less listing request; creating it is lazy.
let catalogModelRuntime: ModelRuntime | undefined;

export async function listAgentCatalogModels(agentDir: string): Promise<ModelOption[]> {
  catalogModelRuntime ??= await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`,
  });
  return listModelOptions(catalogModelRuntime);
}

/**
 * Refreshes the shared session-less catalog in memory and writes the refreshed
 * catalogs to the shared models store on disk. This is the single network pass
 * for a user-initiated model refresh; the main process then syncs every live
 * runtime from the store so no surface shows a different catalog.
 */
export async function refreshAgentCatalogModels(agentDir: string): Promise<void> {
  catalogModelRuntime ??= await ModelRuntime.create({
    authPath: `${agentDir}/auth.json`,
    modelsPath: `${agentDir}/models.json`,
    modelsStorePath: `${agentDir}/models-cache.json`,
  });
  await catalogModelRuntime.refresh({ allowNetwork: true, force: true });
}
