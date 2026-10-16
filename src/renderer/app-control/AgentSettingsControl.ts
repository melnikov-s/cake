import { Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "../../contracts/serialization/json-contract";
import type { AgentSettingsInvocation } from "../../contracts/application/agent-settings-schema";
import { normalizeServerUrl } from "../../contracts/desktop/desktop-host-data";
import type { AgentControlSource } from "./app-control-data";
import type { Client } from "../client/Client";
import type { SettingsStore } from "../stores/SettingsStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { submitNativeMcpAction } from "../lib/native-mcp-action";

export interface AgentSettingsControlHost {
  client: Client;
  settings: SettingsStore;
  signal: AbortSignal;
  workingDirectory(sessionId: string): string | undefined;
  projectSession(sessionId: string): ProjectSessionStore | undefined;
}

/** Stateless adapter: the same Promise Client/domain boundaries used by manual Settings.
 * Native/window controls deliberately target this originating renderer's existing Stores.
 */
export async function invokeAgentSettings(
  host: AgentSettingsControlHost,
  invocation: AgentSettingsInvocation,
  source?: AgentControlSource,
): Promise<JsonValue> {
  const value = await executeAgentSettings(host, invocation, source);
  // Service projections may include undefined optional properties. Only JSON data
  // leaves this application-control adapter; secrets stay masked by their authority.
  return Schema.decodeUnknownPromise(jsonValueSchema)(JSON.parse(JSON.stringify(value)));
}

async function executeAgentSettings(
  host: AgentSettingsControlHost,
  invocation: AgentSettingsInvocation,
  source?: AgentControlSource,
) {
  const { client, settings, signal } = host;
  signal.throwIfAborted();
  const options = { signal };
  const catalog = async () => ({
    chat: await client.models.list(options),
    nonChat: await client.nonChatModels.list(options),
  });
  const desktop = () => {
    const connection = settings.desktopConnection;
    if (!connection)
      throw new Error(
        "Native settings are available only in the originating Cake desktop, not a browser.",
      );
    return connection;
  };
  const dictation = () => {
    desktop();
    return settings.dictation;
  };
  const dictationView = () => {
    const store = dictation();
    return {
      state: store.state ?? null,
      enabled: store.enabled,
      phase: store.phase,
      deviceId: store.deviceId,
      devices: store.devices,
      busy: store.busy,
      installing: store.installing,
      textProcessingMode: store.textProcessingMode,
      error: store.error ?? null,
    };
  };
  switch (invocation.name) {
    case "settings.providers.login": {
      await client.models.login(invocation.arguments, options);
      return { authorized: true, ...(await catalog()) };
    }
    case "settings.mcp.native": {
      const { name, action, sessionId } = invocation.arguments;
      const targetId =
        sessionId ?? (source?.kind === "project-session" ? source.sessionId : undefined);
      const session = targetId ? host.projectSession(targetId) : undefined;
      if (!session)
        throw new Error("Choose an existing idle Project Session for the native MCP action.");
      await client.mcpSettings.get(
        { projectPath: session.workspacePath, revealSecrets: false },
        options,
      );
      const turnId = await submitNativeMcpAction(client, session, name, action, signal);
      return {
        submitted: true,
        sessionId: session.sessionId,
        turnId,
        authorization: "interactive-not-confirmed",
      };
    }
    case "settings.desktop.get": {
      const connection = desktop();
      return {
        host: await client.desktopHost.current(options),
        connected: connection.connected,
        connecting: connection.connecting,
        error: connection.error ?? null,
        sharing: connection.remote ? null : (settings.desktopSharing.state ?? null),
      };
    }
    case "settings.desktop.sharing": {
      if (desktop().remote)
        throw new Error(
          "Desktop sharing is managed in local-host Settings, not remote-host Settings.",
        );
      const sharing = settings.desktopSharing;
      if (sharing.pending)
        throw new Error("Desktop sharing is not ready or is already changing; retry when settled.");
      if (
        sharing.enabled &&
        (invocation.arguments.bind !== sharing.bind ||
          invocation.arguments.port !== Number(sharing.port) ||
          (invocation.arguments.publicOrigin ?? "") !== sharing.publicOrigin)
      )
        throw new Error(
          "Disable desktop sharing before changing its bind address, port or HTTPS origin, as in manual Settings.",
        );
      sharing.setBind(invocation.arguments.bind);
      sharing.setPort(String(invocation.arguments.port));
      sharing.setPublicOrigin(invocation.arguments.publicOrigin ?? "");
      const value = await sharing.configure(invocation.arguments.enabled);
      if (sharing.error) throw new Error(sharing.error);
      if (!value) throw new Error("Desktop sharing is already changing; retry when settled.");
      return value;
    }
    case "settings.desktop.reconnect": {
      const connection = desktop();
      await connection.retry();
      if (connection.error) throw new Error(connection.error);
      return { connected: connection.connected };
    }
    case "settings.desktop.select-host": {
      const connection = desktop();
      if (connection.selecting) throw new Error("Host selection is already in progress.");
      const input = invocation.arguments;
      if (input.kind === "remote") {
        connection.setUrl(normalizeServerUrl(input.url));
        await connection.selectRemote();
      } else await connection.selectLocal();
      if (connection.error) throw new Error(connection.error);
      return { selectionRequested: true, receiptMayBeLost: true };
    }
    case "settings.speech.get": {
      desktop();
      if (!settings.speech.settings)
        throw new Error("Speech settings are still loading. Try again.");
      return settings.speech.settings;
    }
    case "settings.speech.refresh-voices": {
      desktop();
      return client.speechOutput.listVoices(options);
    }
    case "settings.speech.set-voice": {
      desktop();
      const { voiceId } = invocation.arguments;
      if (!settings.speech.voices.some((voice) => voice.id === voiceId))
        throw new Error(
          "Choose a voice ID from settings.speech.get, or refresh the voice list first.",
        );
      await client.speechOutput.setVoice(voiceId, options);
      return { voiceId };
    }
    case "settings.dictation.get":
      return dictationView();
    case "settings.dictation.update": {
      const store = dictation();
      const input = invocation.arguments;
      if (store.busy && input.action !== "cancel-install" && input.action !== "refresh-microphones")
        throw new Error("Dictation installation is busy; wait or cancel the install.");
      if (
        input.action === "enable" &&
        input.enabled &&
        (!store.state?.supported ||
          !store.state.engineAvailable ||
          !store.state.modelPath ||
          store.state.status === "installing")
      )
        throw new Error(
          "Dictation requires a supported desktop, installed speech engine and model, as in manual Settings.",
        );
      store.error = undefined;
      switch (input.action) {
        case "processing":
          store.setTextProcessingMode(input.mode);
          break;
        case "enable":
          await store.setEnabled(input.enabled);
          break;
        case "microphone": {
          if (input.deviceId && !store.devices.some((device) => device.id === input.deviceId))
            throw new Error(
              "Refresh microphones and choose a listed device, or an empty deviceId for the system default.",
            );
          store.setDevice(input.deviceId);
          break;
        }
        case "refresh-microphones":
          await store.refreshDevices();
          break;
        case "install":
          await store.install();
          break;
        case "cancel-install":
          store.cancelInstall();
          break;
        case "remove":
          await store.remove();
          break;
        case "model-path":
          await store.useModelPath(input.path);
          break;
      }
      if (store.error) throw new Error(store.error);
      return dictationView();
    }
    default:
      throw new Error(`${invocation.name} is owned by the backend`);
  }
}
