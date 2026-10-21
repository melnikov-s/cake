import { Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { agentSettingsOperations, settingsOperationGuidance } from "./agent-settings-schema";

const deviceSetting = (name: string) =>
  ["settings.mcp.native", "settings.providers.login"].includes(name) ||
  ["settings.desktop.", "settings.dictation.", "settings.speech."].some((prefix) =>
    name.startsWith(prefix),
  );

const backendSettings: ReadonlySet<string> = new Set(
  agentSettingsOperations
    .filter((definition) => !deviceSetting(definition.command))
    .map((definition) => definition.command),
);
export const isBackendAgentSetting = (name: string) => backendSettings.has(name);

export function agentSettingsTool(
  definition: (typeof agentSettingsOperations)[number],
): CakeControlTool {
  return Schema.decodeUnknownSync(CakeControlTool)({
    command: definition.command,
    topic: "settings",
    summary: definition.summary,
    parameters: Schema.toStandardJSONSchemaV1(definition.input)["~standard"].jsonSchema.input({
      target: "draft-07",
    }),
    guidance: settingsOperationGuidance(definition),
    examples: [{ input: definition.example }],
    result: "The existing Settings service's result; credentials remain masked.",
  });
}

export const backendAgentSettingsTools = () =>
  agentSettingsOperations
    .filter((definition) => isBackendAgentSetting(definition.command))
    .map(agentSettingsTool);
