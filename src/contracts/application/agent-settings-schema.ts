import { Schema } from "effect";
import {
  WidgetPackageInstall,
  WidgetPackageRemove,
  WidgetPackageName,
} from "../widgets/widget-packages";
import { piSettingsSchema, modelOptionSchema } from "../conversations/session-contract";
import { jsonValueSchema } from "../serialization/json-contract";
import { ModelPreset, UtilityModel, SessionLabelMutation, SessionLabel } from "./application-data";
import { NonChatModelPreferences } from "../models/non-chat-model-data";
import { McpSettingsSnapshot, McpSettingsMutation } from "../pi/mcp-settings-data";
import { PiNonChatModel } from "../pi/model-data";
import { VocabularyChange, VocabularyListInput, VocabularyPage } from "../dictation/vocabulary";
import { DictationState, TextProcessingMode } from "../dictation/dictation-data";
import { DesktopSharingInput, DesktopSharingState } from "../desktop/desktop-sharing-data";
import { DesktopHostSelection } from "../desktop/desktop-host-data";
import { NativeMcpConfigEdit } from "../pi/mcp-config-validation";
import { TurnId } from "../conversations/conversation-data";
import { SpeechOutputSettings, SpeechOutputVoice } from "../speech/speech-output-data";
import { AgentListInput } from "../agent/agent-list-data";
import {
  SettingsGetInput,
  SettingsGetOutput,
  SettingsListInput,
  SettingsListOutput,
  SettingsUpdateInput,
  SettingsUpdateOutput,
} from "./settings-catalog";

const empty = Schema.Struct({});
const scope = Schema.Literals(["backend", "project"]);
const id = Schema.String.check(Schema.isUUID(4));
const provider = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const presetProjection = Schema.Struct({
  presets: Schema.Array(ModelPreset),
  defaultPresetId: Schema.optionalKey(id),
});
const providerModelType = Schema.Literals(["chat", "image", "classifier"]);
const providerListInput = Schema.Struct({
  ...AgentListInput.fields,
  provider: Schema.optionalKey(provider),
  type: Schema.optionalKey(providerModelType),
});
const providerModelSummary = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  name: Schema.String,
  type: providerModelType,
  authenticated: Schema.Boolean,
  available: Schema.Boolean,
});
const listPageFields = {
  total: Schema.Int,
  offset: Schema.Int,
  nextOffset: Schema.NullOr(Schema.Int),
};
const providerCatalog = Schema.Struct({
  ...listPageFields,
  items: Schema.Array(providerModelSummary),
});
const widgetPackageList = Schema.Struct({
  ...listPageFields,
  directory: Schema.String,
  items: Schema.Array(Schema.Struct({ name: WidgetPackageName, version: Schema.String })),
});
const modelsView = Schema.Struct({
  presets: Schema.Array(ModelPreset),
  defaultPresetId: Schema.NullOr(id),
  utilityModel: Schema.NullOr(UtilityModel),
  nonChatPreferences: NonChatModelPreferences,
});
const dictationView = Schema.Struct({
  state: Schema.NullOr(DictationState),
  enabled: Schema.Boolean,
  phase: Schema.Literals(["off", "paused", "preparing", "listening", "finishing", "error"]),
  deviceId: Schema.String,
  devices: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  busy: Schema.Boolean,
  installing: Schema.Boolean,
  textProcessingMode: TextProcessingMode,
  error: Schema.NullOr(Schema.String),
});

/** Data-only discovery contract. Backend settings execute in domain handlers; device interactions remain in the originating window. */
function setting<const Name extends string, Input extends Schema.Constraint>(
  name: Name,
  input: Input,
  summary: string,
  example: Record<string, Schema.Json> = {},
  output: Schema.ConstraintDecoder<unknown, never> = jsonValueSchema,
  guidance: readonly string[] = [],
) {
  return {
    command: name,
    input,
    invocation: Schema.Struct({ name: Schema.Literal(name), arguments: input }),
    summary,
    example,
    output,
    guidance,
  };
}

const mcpGuidance = [
  "Project scope means the calling Project Session's exact Working Directory, never an arbitrary path or the currently focused session. Cake Chat supports backend scope only.",
  "Call settings.mcp.get first and pass its revision. Stored values remain masked; preserve the stored-value placeholders to keep credentials. Secrets are never revealed through these operations.",
  "Project scope requires existing Project access and trust. Native Pi validation and same-scope reload are unchanged. OAuth configuration is not authorization; authorize through Pi's existing interactive MCP flow.",
];

export const widgetPackageSettingsOperations = [
  setting(
    "settings.widgets.list",
    AgentListInput,
    "List installed widget package names/versions and directory; filter by query, page with offset/limit (20 default, 50 maximum).",
    {},
    widgetPackageList,
  ),
  setting(
    "settings.widgets.install",
    WidgetPackageInstall,
    "Install a user-approved npm registry dependency for widgets, without rebuilding Cake.",
    { specifier: "@excalidraw/excalidraw", userApproved: true },
    Schema.Struct({ installed: Schema.Literal(true), specifier: Schema.String }),
    [
      "Install only after an explicit user dependency request or explicit approval. Otherwise ask first. userApproved:true records that approval; it is not permission to invent approval.",
      "Packages are shared by all backend widgets, outside Cake's application node_modules. React and ReactDOM are provided by Cake; package paths, URLs and aliases are not supported.",
    ],
  ),
  setting(
    "settings.widgets.remove",
    WidgetPackageRemove,
    "Remove a shared widget dependency. Accepted artifact browser output remains usable.",
    { name: "@excalidraw/excalidraw" },
    Schema.Struct({ removed: Schema.Literal(true), name: WidgetPackageName }),
    [
      "Removal affects future compilation for all backend widgets. Previously accepted browser output is retained.",
    ],
  ),
] as const;

/** Catalog operations carry their own short guidance instead of the shared settings guidance. */
const settingsCatalogCommands: ReadonlySet<string> = new Set([
  "settings.list",
  "settings.get",
  "settings.update",
]);

const settingsCatalogOperations = [
  setting(
    "settings.list",
    SettingsListInput,
    "Start here. No input: setting categories with counts, plus where other settings live. category or query: that category's keys, values, types and changed defaults.",
    { category: "Cake Chat" },
    SettingsListOutput,
  ),
  setting(
    "settings.get",
    SettingsGetInput,
    "Read one setting by key: description, type, full value, default.",
    { key: "cakeChat.contextLimitTokens" },
    SettingsGetOutput,
  ),
  setting(
    "settings.update",
    SettingsUpdateInput,
    "Change one setting by key, live, through the Settings UI's own authority and limits. Returns previous and new values.",
    { key: "cakeChat.contextLimitTokens", value: 500_000 },
    SettingsUpdateOutput,
    [
      "Only when the user asks. Invalid values fail without changes. Prompts accept null to restore the default.",
      "cakeChat.contextLimitTokens returns effective; in a permanent chat effective.thisChat is its real limit (min of the setting and model window minus output reserve). Pi changes reload sessions when idle.",
    ],
  ),
] as const;

export const agentSettingsOperations = [
  ...settingsCatalogOperations,
  ...widgetPackageSettingsOperations,
  setting(
    "settings.pi.reload",
    empty,
    "Reload backend Pi resources for all sessions; busy sessions queue their reload.",
    {},
    piSettingsSchema,
  ),
  setting(
    "settings.models.get",
    empty,
    "Inspect model presets/default, utility model, and backend image/classifier preferences.",
    {},
    modelsView,
  ),
  setting(
    "settings.presets.create",
    Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(80)),
      provider,
      modelId: ModelPreset.fields.modelId,
      prompt: ModelPreset.fields.prompt,
      thinkingLevel: ModelPreset.fields.thinkingLevel,
      fastMode: Schema.Boolean,
    }),
    "Create a configured chat-model preset.",
    {
      name: "My model",
      provider: "openai",
      modelId: "gpt-5.4",
      thinkingLevel: "high",
      fastMode: false,
    },
    presetProjection,
  ),
  setting(
    "settings.presets.update",
    ModelPreset,
    "Replace a preset's editable fields using its existing identity.",
    {},
    presetProjection,
  ),
  setting(
    "settings.presets.reorder",
    Schema.Struct({ ids: Schema.Array(id).check(Schema.isMaxLength(100)) }),
    "Reorder the complete preset list by identity.",
    { ids: [] },
    presetProjection,
  ),
  setting(
    "settings.presets.remove",
    Schema.Struct({ id }),
    "Remove a preset.",
    {},
    presetProjection,
  ),
  setting(
    "settings.providers.list",
    providerListInput,
    "List model identity/name/type and availability; filter provider/type/query, page with offset/limit (20 default, 50 maximum). Use settings.providers.info for details.",
    {},
    providerCatalog,
  ),
  setting(
    "settings.providers.info",
    Schema.Struct({
      provider,
      modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
      type: providerModelType,
    }),
    "Inspect one exact model's capabilities, authentication status and login methods; never stored credentials.",
    { provider: "openai", modelId: "gpt-5.4", type: "chat" },
    Schema.Union([modelOptionSchema, PiNonChatModel]),
  ),
  setting(
    "settings.providers.refresh",
    empty,
    "Refresh provider/model catalogs through Pi; returns confirmation only, not the catalogs.",
    {},
    Schema.Struct({ refreshed: Schema.Literal(true) }),
  ),
  setting(
    "settings.providers.login",
    Schema.Struct({ provider, authType: Schema.Literals(["api_key", "oauth"]) }),
    "Launch the existing provider API-key or OAuth flow on the originating device.",
    { provider: "openrouter", authType: "api_key" },
    Schema.Struct({ provider, authorized: Schema.Literal(true) }),
    [
      "Requires user interaction. API keys/codes are entered in the existing secure dialog, never tool arguments. This waits for the actual flow; cancellation or failure is not authorization.",
    ],
  ),
  setting(
    "settings.providers.logout",
    Schema.Struct({ provider }),
    "Disconnect a provider through Pi's existing credential flow.",
    { provider: "openrouter" },
    Schema.Struct({ provider, disconnected: Schema.Literal(true) }),
  ),
  setting(
    "settings.mcp.get",
    Schema.Struct({ scope }),
    "Read masked native MCP configuration in backend or calling-Project scope.",
    { scope: "backend" },
    McpSettingsSnapshot,
    mcpGuidance,
  ),
  setting(
    "settings.mcp.update",
    Schema.Struct({
      scope,
      revision: McpSettingsMutation.fields.revision,
      name: McpSettingsMutation.fields.name,
      action: McpSettingsMutation.fields.action,
      config: Schema.optionalKey(NativeMcpConfigEdit),
    }),
    "Save, remove, enable or disable an MCP server through authorized native configuration and reload.",
    {
      scope: "backend",
      revision: "revision-from-get",
      name: "docs",
      action: "save",
      config: { command: "docs-mcp", args: [], exposure: "codemode" },
    },
    McpSettingsSnapshot,
    mcpGuidance,
  ),
  setting(
    "settings.mcp.native",
    Schema.Struct({
      name: McpSettingsMutation.fields.name,
      action: Schema.Literals(["login", "logout", "reconnect"]),
      sessionId: Schema.optionalKey(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      ),
    }),
    "Launch Pi's existing native MCP login/logout/reconnect command in an idle Project Session.",
    { name: "docs", action: "login", sessionId: "idle-project-session" },
    Schema.Struct({
      submitted: Schema.Literal(true),
      sessionId: Schema.String,
      turnId: TurnId,
      authorization: Schema.Literal("interactive-not-confirmed"),
    }),
    [
      "Omit sessionId to target the calling Project Session. The calling agent is busy during a tool call; Cake Chat can name an explicitly targeted idle Project Session instead. Requires its existing Project access/trust and built-in MCP command.",
      "Submission is not authorization: follow Pi's existing dialogs/notices. No stored credentials or live connection status are returned.",
    ],
  ),
  setting(
    "settings.labels.get",
    empty,
    "Read global session labels in display order.",
    {},
    Schema.Array(SessionLabel),
  ),
  setting(
    "settings.labels.update",
    Schema.Struct({ mutation: SessionLabelMutation }),
    "Add, rename/recolor, reorder or remove a global label using the existing domain validation.",
    { mutation: { _tag: "MoveLabel", labelId: "00000000-0000-4000-8000-000000000001", index: 0 } },
    Schema.Array(SessionLabel),
  ),
  setting(
    "settings.desktop.get",
    empty,
    "Inspect the originating desktop's host connection and sharing state; not the backend host.",
    {},
    Schema.Struct({
      host: DesktopHostSelection,
      connected: Schema.Boolean,
      connecting: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
      sharing: Schema.NullOr(DesktopSharingState),
    }),
  ),
  setting(
    "settings.desktop.sharing",
    DesktopSharingInput,
    "Configure browser sharing on the originating local desktop (unavailable on browser/remote-host Settings).",
    { enabled: false, bind: "127.0.0.1", port: 4317 },
    DesktopSharingState,
  ),
  setting(
    "settings.desktop.reconnect",
    empty,
    "Retry the originating desktop's selected backend connection.",
    {},
    Schema.Struct({ connected: Schema.Boolean }),
  ),
  setting(
    "settings.desktop.select-host",
    DesktopHostSelection,
    "Launch the originating desktop's existing host-selection/reload flow.",
    { kind: "local" },
    Schema.Struct({
      selectionRequested: Schema.Literal(true),
      receiptMayBeLost: Schema.Literal(true),
    }),
    [
      "Changing hosts reloads this desktop and may disconnect the tool before its receipt. It does not rebind or relocate the calling Project Session. Inspect on the reloaded desktop; do not retry blindly.",
    ],
  ),
  setting(
    "settings.speech.get",
    empty,
    "Read desktop speech settings, provider, local installation state and selected provider's voice list; never credentials. No provider requests.",
    {},
    SpeechOutputSettings,
  ),
  setting(
    "settings.speech.refresh-voices",
    empty,
    "Refresh and persist ElevenLabs voices when selected, or return the built-in local voice without HTTP. No generated audio.",
    {},
    Schema.Array(SpeechOutputVoice),
  ),
  setting(
    "settings.speech.set-voice",
    Schema.Struct({ voiceId: SpeechOutputVoice.fields.id }),
    "Change the desktop's default speaking voice to an ID from settings.speech.get. Applies to subsequent synthesis, not audio already playing.",
    { voiceId: "voice-from-list" },
    Schema.Struct({ voiceId: SpeechOutputVoice.fields.id }),
  ),
  setting(
    "settings.dictation.vocabulary.list",
    VocabularyListInput,
    "Read local dictation vocabulary in bounded searchable pages with a revision for safe edits. Aliases discover acoustic candidates, never unconditional replacements.",
    { limit: 20 },
    VocabularyPage,
  ),
  setting(
    "settings.dictation.vocabulary.change",
    VocabularyChange,
    "Add, update or remove one known word or phrase. Read vocabulary.list first and pass expectedRevision; stale edits fail. Does not download models or change raw/utility processing.",
    { action: "add", expectedRevision: 0, text: "Binks", aliases: ["Banks"] },
    Schema.Struct({ revision: Schema.Int }),
    [
      "3–80 characters per spelling/alias, at most 5 aliases and 100 entries. Case/spacing-equivalent or shared spellings/aliases are rejected. Entries activate on the next utterance after the local vocabulary encoder is installed via settings.dictation.update action install-vocabulary (103 MB). No context or LLM cleanup is used.",
    ],
  ),
  setting(
    "settings.dictation.get",
    empty,
    "Inspect originating desktop dictation installation, enablement, microphones and vocabulary count/revision/encoder availability; never audio. Read entries with settings.dictation.vocabulary.list.",
    {},
    dictationView,
  ),
  setting(
    "settings.dictation.update",
    Schema.Union([
      Schema.Struct({ action: Schema.Literal("enable"), enabled: Schema.Boolean }),
      Schema.Struct({ action: Schema.Literal("processing"), mode: TextProcessingMode }),
      Schema.Struct({
        action: Schema.Literal("microphone"),
        deviceId: Schema.String.check(Schema.isMaxLength(4096)),
      }),
      Schema.Struct({
        action: Schema.Literals([
          "refresh-microphones",
          "install",
          "install-vocabulary",
          "cancel-install",
          "remove",
        ]),
      }),
      Schema.Struct({
        action: Schema.Literal("model-path"),
        path: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      }),
    ]),
    "Use the originating desktop's shared Voice & Dictation controls, including local recognition or optional utility cleanup, recognition model and microphone selection.",
    { action: "enable", enabled: false },
    dictationView,
    [
      "Desktop only. Enabling dictation can request microphone permission and record into the focused writing surface. Installing downloads the existing native model; install-vocabulary explicitly downloads a separate 103 MB local CTC encoder. cancel-install cancels either download. remove deletes Cake model data (including CTC) but preserves vocabulary. Empty vocabulary adds no inference. Active vocabulary adds a local CTC pass to each live revision; changes apply to the next utterance. model-path uses existing native manifest/path validation.",
    ],
  ),
] as const;

export const AgentSettingsInvocation = Schema.Union(
  agentSettingsOperations.map((operation) => operation.invocation),
);
export type AgentSettingsInvocation = typeof AgentSettingsInvocation.Type;

/** Shared settings guidance, except for catalog operations whose help stays short. */
export const settingsOperationGuidance = (operation: {
  readonly command: string;
  readonly guidance: readonly string[];
}) =>
  settingsCatalogCommands.has(operation.command)
    ? operation.guidance
    : [...agentSettingsGuidance, ...operation.guidance];

const agentSettingsGuidance = [
  "Backend settings execute on the selected backend through the same domain/services as manual Settings, without requiring a connected window. Native/device interactions still target the originating Cake window; appearance/editor/hotkeys remain window-local via settings.window.get/update.",
  "Scalar settings (Pi, model defaults, instructions, prompts, Cake Chat) change with settings.update; find keys with settings.list. Current chat model uses session.set-model.",
  "Cancellation does not undo a setting already saved. Interactive credentials and permissions remain user-owned; stored credentials are never returned.",
];
