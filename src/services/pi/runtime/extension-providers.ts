import type { ModelRuntime, ResourceLoader } from "@earendil-works/pi-coding-agent";

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
