import {
  DefaultResourceLoader,
  SettingsManager,
  type ModelRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/**
 * Registers the providers that extensions queued while loading, so they exist
 * on `modelRuntime` before anything resolves a model against it.
 *
 * `createAgentSession()` picks the initial model — the settings default, or the
 * model a resumed session recorded — *before* constructing the AgentSession
 * whose extension binding flushes these registrations. On a fresh ModelRuntime
 * every extension-registered provider is therefore unknown at that moment: the
 * lookup fails, Pi falls back to the first authenticated built-in model, and
 * appends that fallback to the session file as a model change. Pi's own CLI
 * avoids this in `createAgentSessionServices()` by flushing first; this mirrors
 * that step for Cake's loader-owning runtimes.
 *
 * Returns registration failures as messages. A failed registration never
 * blocks the session; the binding step later sees an empty queue.
 */
export async function registerPendingExtensionProviders(
  resourceLoader: ResourceLoader,
  modelRuntime: ModelRuntime,
): Promise<string[]> {
  const { runtime } = resourceLoader.getExtensions();
  const errors: string[] = [];
  const describe = (extensionPath: string, error: unknown) =>
    `Extension "${extensionPath}" error: ${error instanceof Error ? error.message : String(error)}`;

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

/**
 * Registers the providers of the agent directory's extensions on a runtime
 * whose own session loads no extensions: auxiliary sessions, isolated runs,
 * and the shared model catalog.
 *
 * Which models a runtime can reach is a separate concern from which extension
 * behavior (hooks, tools, commands, UI) binds to a session. A model chosen for
 * the main chat should resolve in a side chat too, so agent-directory
 * extensions contribute providers everywhere while their behavior binds only
 * where extensions load. `cwd` is the agent directory rather than a project,
 * so no project's `.pi/` is consulted. Best-effort: failures are returned as
 * messages and leave the built-in providers in place.
 */
export async function registerAgentDirectoryExtensionProviders(
  agentDirectory: string,
  modelRuntime: ModelRuntime,
): Promise<string[]> {
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
    return await registerPendingExtensionProviders(resourceLoader, modelRuntime);
  } catch (error) {
    return [
      `Agent-directory extension providers unavailable: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
}
