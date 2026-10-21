import { Effect, Schema, Struct } from "effect";
import type { AgentSettingsInvocation } from "../../contracts/application/agent-settings-schema";
import {
  defaultCakePrompts,
  resolveCakePrompts,
} from "../../contracts/application/cake-prompt-defaults";
import { ApplicationState } from "../../services/storage/ApplicationState";
import { PiModels } from "../../services/pi/PiModels";
import { PiSettings } from "../../services/pi/PiSettings";

import { WidgetPackages } from "../../services/widgets/WidgetPackages";
import * as application from "./application";
import * as piSettings from "./piSettings";
import * as settingsCatalog from "./settingsCatalog";
import * as modelPresets from "../model-presets/modelPresets";
import { updateNonChatModelPreference } from "../model-preferences/non-chat-model-preferences";
import { loadMcpSettings, mutateMcpSettings } from "../mcp/mcp-settings";
import { toJsonValue } from "../../utils/to-json-value";
import { agentListLabel, agentListPage } from "../../contracts/agent/agent-list-data";

const catalog = Effect.fn("AgentSettings.catalog")(function* () {
  const models = yield* PiModels;
  return {
    chat: (yield* models.list()).map(({ supportedThinkingLevels, ...model }) => ({
      ...model,
      availableThinkingLevels: supportedThinkingLevels,
    })),
    nonChat: yield* models.listNonChat(),
  };
});

export const invoke = Effect.fn("AgentSettings.invoke")(function* (
  invocation: AgentSettingsInvocation,
  caller: { readonly kind: "project-session" | "cake-chat"; readonly workingDirectory?: string },
) {
  const value = yield* Effect.gen(function* () {
    switch (invocation.name) {
      case "settings.widgets.list": {
        const snapshot = yield* (yield* WidgetPackages).list();
        const query = invocation.arguments.query?.toLowerCase();
        const packages = snapshot.packages.filter(
          (item) => !query || item.name.toLowerCase().includes(query),
        );
        return { directory: snapshot.directory, ...agentListPage(packages, invocation.arguments) };
      }
      case "settings.widgets.install":
        yield* (yield* WidgetPackages).install(invocation.arguments.specifier);
        return { installed: true, specifier: invocation.arguments.specifier };
      case "settings.widgets.remove":
        yield* (yield* WidgetPackages).remove(invocation.arguments.name);
        return { removed: true, name: invocation.arguments.name };
      case "settings.pi.get":
        return yield* (yield* PiSettings).load();
      case "settings.pi.update":
        return yield* piSettings.update(invocation.arguments);
      case "settings.pi.reload":
        return yield* piSettings.reload();
      case "settings.models.get": {
        const state = (yield* ApplicationState).snapshot();
        return {
          presets: state.modelPresets,
          defaultPresetId: state.defaultModelPresetId ?? null,
          utilityModel: state.utilityModel ?? null,
          nonChatPreferences: state.nonChatModelPreferences ?? {},
        };
      }
      case "settings.models.set-utility": {
        const state = yield* application.setUtilityModel(invocation.arguments.model ?? undefined);
        return { utilityModel: state.utilityModel ?? null };
      }
      case "settings.models.set-non-chat":
        return yield* updateNonChatModelPreference(invocation.arguments);
      case "settings.presets.create":
        return yield* modelPresets.create(invocation.arguments);
      case "settings.presets.update":
        return yield* modelPresets.update(invocation.arguments);
      case "settings.presets.reorder":
        return yield* modelPresets.reorder(invocation.arguments);
      case "settings.presets.remove":
        return yield* modelPresets.remove(invocation.arguments.id);
      case "settings.presets.set-default":
        return yield* modelPresets.setDefault(invocation.arguments.id ?? undefined);
      case "settings.providers.list": {
        const { chat, nonChat } = yield* catalog();
        const input = invocation.arguments;
        const query = input.query?.toLowerCase();
        const entries = [...chat.map((model) => ({ ...model, type: "chat" as const })), ...nonChat]
          .filter(
            (model) =>
              (!input.provider || model.provider === input.provider) &&
              (!input.type || model.type === input.type) &&
              (!query ||
                [model.id, model.name, model.provider, model.providerName].some((value) =>
                  value.toLowerCase().includes(query),
                )),
          )
          .map(({ id, provider, name, type, authenticated, available }) => ({
            id,
            provider,
            name: agentListLabel(name),
            type,
            authenticated,
            available,
          }));
        return agentListPage(entries, input);
      }
      case "settings.providers.info": {
        const { provider, modelId, type } = invocation.arguments;
        const models = yield* PiModels;
        const entries =
          type === "chat"
            ? (yield* models.list()).map(({ supportedThinkingLevels, ...model }) => ({
                ...model,
                availableThinkingLevels: supportedThinkingLevels,
              }))
            : (yield* models.listNonChat()).filter((model) => model.type === type);
        const model = entries.find((entry) => entry.provider === provider && entry.id === modelId);
        if (!model)
          return yield* new AgentControlError({
            message: `Unknown ${type} model: ${provider}/${modelId}`,
          });
        return model;
      }
      case "settings.providers.refresh": {
        yield* (yield* PiModels).refreshCatalog();
        return { refreshed: true };
      }
      case "settings.providers.logout": {
        yield* (yield* PiModels).logout(invocation.arguments.provider);
        return { provider: invocation.arguments.provider, disconnected: true };
      }
      case "settings.mcp.get":
      case "settings.mcp.update": {
        const { scope } = invocation.arguments;
        const projectPath =
          scope === "project" && caller.kind === "project-session"
            ? caller.workingDirectory
            : undefined;
        if (scope === "project" && !projectPath)
          return yield* new AgentControlError({
            message: "Project MCP scope requires the calling Project Session's Working Directory.",
          });
        if (invocation.name === "settings.mcp.get")
          return yield* loadMcpSettings({
            ...(projectPath ? { projectPath } : null),
            revealSecrets: false,
          });
        const mutation = Struct.omit(invocation.arguments, ["scope"]);
        return yield* mutateMcpSettings({ ...mutation, ...(projectPath ? { projectPath } : null) });
      }
      case "settings.instructions.get": {
        const state = (yield* ApplicationState).snapshot();
        return {
          instructions: state.globalCustomInstructions,
          prompts: resolveCakePrompts(state.cakePrompts),
          defaults: defaultCakePrompts(),
        };
      }
      case "settings.instructions.update": {
        const state = yield* application.setGlobalCustomInstructions(
          invocation.arguments.instructions,
        );
        return { instructions: state.globalCustomInstructions };
      }
      case "settings.prompts.update": {
        const { key, value } = invocation.arguments;
        const state = yield* application.setCakePrompt(key, value);
        return { prompts: resolveCakePrompts(state.cakePrompts) };
      }
      case "settings.list":
        return yield* settingsCatalog.list(invocation.arguments);
      case "settings.get":
        return yield* settingsCatalog.get(invocation.arguments);
      case "settings.update":
        return yield* settingsCatalog.update(invocation.arguments);
      case "settings.labels.get":
        return (yield* ApplicationState).snapshot().globalSessionLabels;
      case "settings.labels.update":
        return (yield* application.mutateGlobalSessionLabels(invocation.arguments.mutation))
          .globalSessionLabels;
      default:
        return yield* new AgentControlError({
          message: `${invocation.name} requires the originating device`,
        });
    }
  });
  return toJsonValue({ ok: true, command: invocation.name, value });
});

export class AgentControlError extends Schema.TaggedError<AgentControlError>()(
  "AgentControlError",
  { message: Schema.String },
) {}
