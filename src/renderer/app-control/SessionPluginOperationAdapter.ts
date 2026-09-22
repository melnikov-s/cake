import type { JsonObject, JsonValue } from "../../ipc/json-contract";
import type { Client } from "../client/Client";
import type { SessionPluginStore } from "../stores/SessionPluginStore";

export interface SessionPluginOperationCapabilities {
  client: Client;
  signal: AbortSignal;
  plugins: SessionPluginStore;
  workingDirectory(sessionId: string): string;
  prepareChat(sessionId: string): Promise<void>;
}

/** Interprets plugin commands at the plugin/application boundary. */
export function createSessionPluginOperationAdapter(
  capabilities: SessionPluginOperationCapabilities,
) {
  return {
    async invoke(
      sessionId: string,
      pluginId: string,
      command: string,
      input: JsonObject,
    ): Promise<JsonValue> {
      if (command === "session.prompt") {
        const text = String(input.text ?? "").trim();
        if (!text) throw new Error("session.prompt requires non-empty text");
        await capabilities.prepareChat(sessionId);
        await capabilities.client.sessionChats.prompt(
          {
            sessionId,
            text,
            attachments: [],
            renderUserMessageAsMarkdown: false,
          },
          { signal: capabilities.signal },
        );
        return { accepted: true };
      }
      if (command === "plugins.set-state") {
        if (!("state" in input)) throw new Error("plugins.set-state requires state");
        await capabilities.plugins.setPluginState(sessionId, pluginId, input.state);
        return { updated: true };
      }
      if (command === "plugins.set-shared-state") {
        const key = String(input.key ?? "").trim();
        if (!key || !("value" in input))
          throw new Error("plugins.set-shared-state requires key and value");
        await capabilities.plugins.setSharedState(sessionId, key, input.value);
        return { updated: true };
      }
      if (command === "plugins.delete") {
        await capabilities.plugins.delete(sessionId, pluginId);
        return { deleted: true };
      }
      return capabilities.client.projectSessions.callCakeOperation(
        {
          sessionId,
          workingDirectory: capabilities.workingDirectory(sessionId),
          command,
          input,
        },
        { signal: capabilities.signal },
      );
    },
  };
}
