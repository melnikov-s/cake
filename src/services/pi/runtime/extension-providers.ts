import {
  antigravityDesktopOnly,
  isAntigravityModel,
} from "../../../contracts/model-presets/antigravity-model";
import {
  DefaultResourceLoader,
  SettingsManager,
  type ModelRuntime,
  type RegisteredMcpServer,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * Registers the providers that extensions queued while loading, so they exist
 * on `modelRuntime` before anything resolves a model against it.
 *
 * Register before Cake resolves the selected model and hands it to the SDK.
 * Pi's standalone CLI also flushes providers before its own model selection.
 *
 * Returns registration failures and provider-only compatibility diagnostics.
 * The binding step later sees an empty queue.
 */
export async function registerPendingExtensionProviders(
  resourceLoader: ResourceLoader,
  modelRuntime: ModelRuntime,
  options: { sessionless?: boolean } = {},
): Promise<string[]> {
  const { runtime, extensions } = resourceLoader.getExtensions();
  const errors: string[] = [];
  const describe = (extensionPath: string, error: unknown) =>
    `Extension "${extensionPath}" error: ${error instanceof Error ? error.message : String(error)}`;

  // A provider-only loader must not borrow another session's captures, cwd, or
  // policy hooks. Pi has no declaration that a provider is independent of its
  // extension's handlers, so keep its catalog but refuse execution conservatively.
  if (options.sessionless) {
    const blocked = new Map<string, string>();
    for (const registration of [
      ...runtime.pendingProviderRegistrations.map(({ name, extensionPath }) => ({
        name,
        extensionPath,
      })),
      ...runtime.pendingNativeProviderRegistrations.map(({ provider, extensionPath }) => ({
        name: provider.id,
        extensionPath,
      })),
    ]) {
      const extension = extensions.find((entry) => entry.path === registration.extensionPath);
      const hooks = [...(extension?.handlers.keys() ?? [])].filter(
        (event) => event !== "project_trust",
      );
      if (hooks.length === 0) continue;
      const message = `Provider "${registration.name}" from extension "${registration.extensionPath}" is unsupported in Cake Chat, auxiliary sessions, and sessionless requests: this runtime does not bind Pi session hooks (${hooks.join(", ")}). Cake will not substitute process.cwd() or omit prompt/tool policy. Use a regular Project Session, or ask the extension author to separate a factory-registered, lifecycle-independent provider that accepts the complete Pi transcript.`;
      blocked.set(registration.name, message);
      errors.push(message);
    }
    if (blocked.size > 0) guardSessionlessProviderRequests(modelRuntime, blocked);
  }

  for (const { name, config, extensionPath } of runtime.pendingProviderRegistrations) {
    try {
      modelRuntime.registerProvider(name, config);
    } catch (error) {
      errors.push(describe(extensionPath, error));
    }
  }
  runtime.pendingProviderRegistrations = [];

  for (const { provider, extensionPath } of runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (error) {
      errors.push(describe(extensionPath, error));
    }
  }
  runtime.pendingNativeProviderRegistrations = [];

  // Recompute availability so the initial-model resolution sees the new
  // providers as configured.
  await modelRuntime.refresh({ allowNetwork: false });
  return errors;
}

/** Guard the public request boundary, not Pi internals or another runtime's providers. */
function guardSessionlessProviderRequests(
  runtime: ModelRuntime,
  blocked: ReadonlyMap<string, string>,
): void {
  const assertSupported = (provider: string) => {
    const error = blocked.get(provider);
    if (error) throw new Error(error);
  };
  const stream = runtime.stream.bind(runtime);
  const streamSimple = runtime.streamSimple.bind(runtime);
  const streamDeferred = runtime.streamDeferred.bind(runtime);
  runtime.stream = (model, context, options) => {
    assertSupported(model.provider);
    return stream(model, context, options);
  };
  runtime.streamSimple = (model, context, options) => {
    assertSupported(model.provider);
    return streamSimple(model, context, options);
  };
  runtime.streamDeferred = (model, handle, options) => {
    assertSupported(model.provider);
    return streamDeferred(model, handle, options);
  };
}

/** Never let Pi persist a fallback for a selected provider that has not registered. */
export function requireRegisteredModel(
  runtime: Pick<ModelRuntime, "getModel">,
  selection: { provider: string; modelId: string },
) {
  if (isAntigravityModel(selection)) throw new Error(antigravityDesktopOnly);
  const model = runtime.getModel(selection.provider, selection.modelId);
  if (!model)
    throw new Error(
      `Selected model ${selection.provider}/${selection.modelId} is unavailable. Cake will not substitute another model. Extension providers must register in every extension factory invocation, before model selection; process-wide first-instance registration or deferring registration to session_start is unsupported. Update the extension to register per runtime, or choose an available model in Settings.`,
    );
  return model;
}

/**
 * Registers the providers of the agent directory's extensions on a runtime
 * whose own session loads no extensions: auxiliary sessions, isolated runs,
 * and the shared model catalog.
 *
 * Which models a runtime can reach is a separate concern from which extension
 * behavior (hooks, tools, commands, UI) binds to a session. Agent-directory
 * extensions contribute catalogs everywhere, but providers with unbound hooks
 * cannot execute: their prompt, cwd, and policy requirements cannot be assumed.
 * `cwd` is the agent directory rather than a project,
 * so no project's `.pi/` is consulted. Best-effort: failures are returned as
 * messages and leave the built-in providers in place.
 */
export async function registerAgentDirectoryExtensionProviders(
  agentDirectory: string,
  modelRuntime: ModelRuntime,
): Promise<string[]> {
  return (await loadAgentDirectoryExtensions(agentDirectory, modelRuntime)).errors;
}

/**
 * As {@link registerAgentDirectoryExtensionProviders}, also returning the MCP servers those
 * extensions registered (for example the Tool Gateway), for Cake Chat's own MCP client.
 */
export async function loadAgentDirectoryExtensions(
  agentDirectory: string,
  modelRuntime: ModelRuntime,
): Promise<{ errors: string[]; mcpServers: RegisteredMcpServer[] }> {
  try {
    const settingsManager = SettingsManager.create(agentDirectory, agentDirectory, {
      projectTrusted: true,
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDirectory,
      agentDir: agentDirectory,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await resourceLoader.reload({ resolveProjectTrust: async () => true });
    const errors = [
      ...resourceLoader
        .getExtensions()
        .errors.map(({ path, error }) => `Extension "${path}" error: ${error}`),
      ...(await registerPendingExtensionProviders(resourceLoader, modelRuntime)),
    ];
    return { errors, mcpServers: resourceLoader.getExtensions().runtime.mcpServers.list() };
  } catch (error) {
    return {
      errors: [
        `Agent-directory extension providers unavailable: ${error instanceof Error ? error.message : String(error)}`,
      ],
      mcpServers: [],
    };
  }
}
