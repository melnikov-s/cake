import type { PluginPromiseOperations } from "./PluginRuntime";
import type { PluginOperationContext } from "./PluginOperationContext";

type AuthoringOperation =
  | "get-customization-state"
  | "get-plugin-authoring-reference"
  | "list-plugin-files"
  | "create-plugin"
  | "read-plugin-file"
  | "write-plugin-file"
  | "validate-customization"
  | "activate-customization"
  | "rollback-customization"
  | "use-factory-customization"
  | "list-plugins"
  | "set-plugin-enabled"
  | "set-active-scene"
  | "delete-plugin";

export const makePluginAuthoringOperations = (
  context: PluginOperationContext,
): Pick<PluginPromiseOperations, AuthoringOperation> => ({
  "get-customization-state": async () => ({ state: context.activation.snapshot() }),
  "get-plugin-authoring-reference": async () => ({
    reference: await context.activation.builder.authoringReference(),
  }),
  "list-plugin-files": async () => context.activation.builder.repository.authoringSnapshot(),
  "create-plugin": async (_connectionId, request) =>
    context.activation.builder.repository.createPlugin(
      {
        id: request.pluginId,
        name: request.name,
        renderer: request.renderer,
        backend: request.backend,
        scene: request.scene,
      },
      request.expectedWorkingRevision,
    ),
  "read-plugin-file": async (_connectionId, request) => ({
    pluginId: request.pluginId,
    path: request.path,
    content: await context.activation.builder.repository.readPluginFile(
      request.pluginId,
      request.path,
    ),
  }),
  "write-plugin-file": async (_connectionId, request) =>
    context.activation.builder.repository.writePluginFile(
      request.pluginId,
      request.path,
      request.content,
      request.expectedWorkingRevision,
    ),
  "validate-customization": async (_connectionId, request) => {
    const candidate = await context.activation.validate(
      request.expectedBaseRevision,
      request.request,
      request.expectedSourceRevision,
    );
    const response = {
      type: "customization-validation" as const,
      revision: candidate.revision,
      sourceRevision: candidate.sourceRevision,
      diagnostics: candidate.diagnostics,
      valid: candidate.diagnostics.length === 0,
    };
    context.customizationChanged(candidate.diagnostics.length > 0);
    return response;
  },
  "activate-customization": async (_connectionId, request) => {
    const candidate = await context.activation.activateValidated(
      request.revision,
      request.expectedSourceRevision,
      request.request,
    );
    try {
      await context.backends.activate(candidate.revision);
    } catch (error) {
      const diagnostic = {
        phase: "backend" as const,
        message: error instanceof Error ? error.message : String(error),
      };
      await context.activation.fail(candidate.revision, diagnostic);
      context.customizationChanged(true);
      throw error;
    }
    context.customizationChanged(false);
    await context.refreshAgentResources();
    context.reloadAll({
      kind: "custom",
      revision: candidate.revision,
      path: candidate.indexHtml,
    });
    return {
      type: "customization-activation" as const,
      revision: candidate.revision,
      activating: true as const,
    };
  },
  "rollback-customization": async () => {
    const revision = await context.activation.rollback();
    try {
      await context.backends.activate(revision);
    } catch (error) {
      await context.activation.fail(revision, {
        phase: "backend",
        message: error instanceof Error ? error.message : String(error),
      });
      context.customizationChanged(true);
      context.reloadAll({ kind: "factory" });
      return { state: context.activation.snapshot() };
    }
    context.customizationChanged(true);
    context.reloadAll(
      revision
        ? { kind: "custom", revision, path: context.activation.buildPath(revision) }
        : { kind: "factory" },
    );
    return { state: context.activation.snapshot() };
  },
  "use-factory-customization": async () => {
    await context.activation.useFactory();
    await context.backends.stop();
    context.customizationChanged(true);
    context.reloadAll({ kind: "factory" });
    return { state: context.activation.snapshot() };
  },
  "list-plugins": async () => ({
    plugins: await context.activation.builder.repository.listPluginStatuses(),
  }),
  "set-plugin-enabled": async (_connectionId, request) => {
    const plugins = await context.activation.builder.repository.setEnabled(
      request.pluginId,
      request.enabled,
    );
    await context.refreshAgentResources();
    await context.rebuildAfterConfigurationChange(
      `${request.enabled ? "Enable" : "Disable"} plugin ${request.pluginId}`,
    );
    return { plugins };
  },
  "set-active-scene": async (_connectionId, request) => ({
    plugins: await context.activation.builder.repository.setActiveScene(request.pluginId),
  }),
  "delete-plugin": async (_connectionId, request) => {
    const { wasEnabled, plugins } = await context.activation.builder.repository.deletePlugin(
      request.pluginId,
    );
    await context.refreshAgentResources();
    if (wasEnabled) {
      await context.backends.stop();
      await context.activation.fail(context.activation.snapshot().activeRevision, {
        phase: "discovery",
        pluginId: request.pluginId,
        message: `Plugin ${request.pluginId} was deleted. Rebuild the customization to activate the remaining plugins.`,
      });
      context.customizationChanged(true);
      context.reloadAll({ kind: "factory" });
    }
    return { plugins };
  },
});
