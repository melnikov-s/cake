import type { PluginPromiseOperations } from "./PluginRuntime";
import { compileInlineWidget, extractRepairedWidget } from "../widgets/inline-widget-service";
import { runInlineWidgetRepair } from "../pi/runtime/sidecar-runtime";
import type { PluginOperationContext } from "./PluginOperationContext";

type RuntimeOperation =
  | "compile-inline-widget"
  | "repair-inline-widget"
  | "load-plugin-state"
  | "save-plugin-state"
  | "call-plugin-backend"
  | "cancel-plugin-backend-call"
  | "customization-rendered"
  | "customization-runtime-failed";

export const makePluginRuntimeOperations = (
  context: PluginOperationContext,
): Pick<PluginPromiseOperations, RuntimeOperation> => ({
  "compile-inline-widget": async (_connectionId, request) => ({
    widget: context.publishInlineWidget(
      await compileInlineWidget(request.language, request.source, request.capability),
    ),
  }),
  "repair-inline-widget": async (_connectionId, request) => {
    const workingDirectory = await context.resolveSessionWorkspacePath(request.sessionId);
    if (!context.isWorkingDirectoryAllowed(workingDirectory))
      throw new Error("Project path was not selected by the user");
    const repaired = await runInlineWidgetRepair({
      cwd: workingDirectory,
      agentDir: context.paths.piAgent,
      sessionDir: context.paths.piWidgetSessions,
      language: request.language,
      capability: request.capability,
      source: request.source,
      context: request.context,
      diagnostic: request.diagnostic,
      model: request.model,
    });
    return {
      widget: {
        source: extractRepairedWidget(repaired.response, request.language),
        repairSessionId: repaired.sessionId,
      },
    };
  },
  "load-plugin-state": async (_connectionId, request) => ({
    record: await context.persistence.read(request.pluginId, request.key, request.scope),
  }),
  "save-plugin-state": async (connectionId, request) => {
    const sender = context.requireRendererConnection(connectionId);
    const rendererRevision =
      context.windowRevisions.get(sender.id) ?? context.activation.snapshot().activeRevision;
    return {
      record: await context.persistence.write(
        request.pluginId,
        request.key,
        request.scope,
        request.value,
        request.expectedVersion,
        rendererRevision,
      ),
    };
  },
  "call-plugin-backend": async (_connectionId, request) => {
    try {
      return {
        callId: request.callId,
        ok: true as const,
        value: await context.backends.call(
          request.pluginId,
          request.callId,
          request.method,
          request.input,
        ),
      };
    } catch (error) {
      return {
        callId: request.callId,
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  "cancel-plugin-backend-call": async (_connectionId, request) => {
    context.backends.cancel(request.pluginId, request.callId);
    return { requestId: request.callId };
  },
  "customization-rendered": async (connectionId, request) => {
    const sender = context.requireRendererConnection(connectionId);
    if (context.windowRevisions.get(sender.id) !== request.revision)
      throw new Error("Customization health report does not match this window");
    const current = context.activation.snapshot();
    const activating = current.pendingRevision === request.revision;
    if (activating) await context.activation.markHealthy(request.revision);
    else if (current.activeRevision !== request.revision)
      throw new Error("Customization revision is not active");
    const healthTimer = context.healthTimers.get(sender.id);
    if (healthTimer) clearTimeout(healthTimer);
    context.healthTimers.delete(sender.id);
    context.customizationChanged(activating);
    return { state: context.activation.snapshot() };
  },
  "customization-runtime-failed": async (_connectionId, request) => {
    await context.backends.stop();
    await context.activation.fail(request.revision, {
      phase: "runtime",
      message: request.message,
    });
    context.customizationChanged(true);
    context.reloadAll({ kind: "factory" });
    return { state: context.activation.snapshot() };
  },
});
