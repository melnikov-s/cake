import type { PluginPromiseOperations } from "./PluginRuntime";
import type { PluginOperationContext } from "./PluginOperationContext";

type AgentOperation =
  | "open-plugin-agent"
  | "prompt-plugin-agent"
  | "abort-plugin-agent"
  | "detach-plugin-agent"
  | "run-plugin-completion"
  | "cancel-plugin-completion";

export const makePluginAgentOperations = (
  context: PluginOperationContext,
): Pick<PluginPromiseOperations, AgentOperation> => ({
  "open-plugin-agent": async (connectionId, request) => {
    const sender = context.applicationWindowConnection(connectionId);
    return {
      snapshot: await context.agents.open(
        sender,
        request.pluginId,
        request.options,
        request.implicitSession,
      ),
    };
  },
  "prompt-plugin-agent": async (connectionId, request) => {
    const sender = context.applicationWindowConnection(connectionId);
    return {
      snapshot: await context.agents.command(
        sender,
        request.pluginId,
        request.handleId,
        request.delivery,
        request.text,
      ),
    };
  },
  "abort-plugin-agent": async (connectionId, request) => {
    const sender = context.applicationWindowConnection(connectionId);
    return {
      snapshot: await context.agents.abort(sender, request.pluginId, request.handleId),
    };
  },
  "detach-plugin-agent": async (connectionId, request) => {
    const sender = context.applicationWindowConnection(connectionId);
    context.agents.detach(sender, request.pluginId, request.handleId);
    return { handleId: request.handleId };
  },
  "run-plugin-completion": async (connectionId, request) => {
    const sender = context.requireRendererConnection(connectionId);
    const key = `${sender.id}:${request.pluginId}:${request.requestId}`;
    const controller = new AbortController();
    context.completionControllers.set(key, controller);
    try {
      const result = await context.agents.complete(
        request.pluginId,
        request.request,
        request.implicitSession,
        controller.signal,
      );
      return { requestId: request.requestId, result };
    } finally {
      if (context.completionControllers.get(key) === controller)
        context.completionControllers.delete(key);
    }
  },
  "cancel-plugin-completion": async (connectionId, request) => {
    const sender = context.requireRendererConnection(connectionId);
    context.completionControllers
      .get(`${sender.id}:${request.pluginId}:${request.requestId}`)
      ?.abort();
    return { requestId: request.requestId };
  },
});
