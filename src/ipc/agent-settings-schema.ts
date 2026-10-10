import { Schema } from "effect";
import { piSettingUpdateSchema, piSettingsSchema, modelOptionSchema } from "./session-contract";
import { jsonValueSchema } from "./json-contract";
import {
  ModelPreset,
  UtilityModel,
  SessionLabelMutation,
  SessionLabel,
} from "../services/storage/application-data";
import { CakePrompts } from "../services/storage/cake-prompt-data";
import {
  NonChatModelPreferenceUpdate,
  NonChatModelPreferences,
} from "../services/storage/non-chat-model-data";
import { McpSettingsSnapshot, McpSettingsMutation } from "../services/pi/mcp-settings-data";
import { PiNonChatModel } from "../services/pi/model-data";
import { DictationState, TextProcessingMode } from "../services/dictation/dictation-data";
import {
  DesktopSharingInput,
  DesktopSharingState,
} from "../services/electron/desktop-sharing-data";
import { DesktopHostSelection } from "../services/electron/desktop-host-data";
import { NativeMcpConfigEdit } from "../services/pi/mcp-config-validation";
import { cakeSettingsSections } from "./cake-settings-data";
import { TurnId } from "./conversation-data";
import { SpeechOutputSettings, SpeechOutputVoice } from "../services/speech/speech-output-data";

const empty = Schema.Struct({});
const scope = Schema.Literals(["backend", "project"]);
const id = Schema.String.check(Schema.isUUID(4));
const provider = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const text = Schema.String.check(Schema.isMaxLength(16_384));
const presetProjection = Schema.Struct({
  presets: Schema.Array(ModelPreset),
  defaultPresetId: Schema.optionalKey(id),
});
const providerCatalog = Schema.Struct({
  chat: Schema.Array(modelOptionSchema),
  nonChat: Schema.Array(PiNonChatModel),
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
  installingPunctuation: Schema.Boolean,
  processingError: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

/** Data-only discovery contract. Execution stays behind the existing originating-window Client. */
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

export const agentSettingsOperations = [
  setting(
    "settings.pi.get",
    empty,
    "Read backend Pi behavior, defaults, execution, resources and network settings.",
    {},
    piSettingsSchema,
  ),
  setting(
    "settings.pi.update",
    piSettingUpdateSchema,
    "Update one validated backend Pi setting using the manual Settings persistence and reload policy.",
    { key: "defaultTools", value: ["+codemode", "+tool_search"] },
    piSettingsSchema,
    [
      "defaultTools: null restores Pi defaults, [] disables built-ins, plain names replace defaults, +name adds and -name removes. Both codemode and tool_search are native entries.",
      "Reload may be queued while sessions run. Removing a tool does not disable it in an already-started session; restart that session. Enabling tools never invokes a billed model.",
    ],
  ),
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
    "settings.models.set-utility",
    Schema.Struct({ model: Schema.NullOr(UtilityModel) }),
    "Set or clear the backend utility model; null disables background utility calls.",
    { model: null },
    Schema.Struct({ utilityModel: Schema.NullOr(UtilityModel) }),
  ),
  setting(
    "settings.models.set-non-chat",
    NonChatModelPreferenceUpdate,
    "Set or clear an advisory backend image/classifier model preference.",
    { type: "image", preference: null },
    NonChatModelPreferences,
    [
      "Use native models.select-non-chat in eligible Project Session codemode to consume this preference. Explicit requested models override it; unavailable selections fail without substitution.",
    ],
  ),
  setting(
    "settings.presets.create",
    Schema.Struct({
      name: Schema.String.check(Schema.isMaxLength(80)),
      provider,
      modelId: ModelPreset.fields.modelId,
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
    "settings.presets.set-default",
    Schema.Struct({ id: Schema.NullOr(id) }),
    "Set the default preset for new Cake chats; null restores Pi's default.",
    { id: null },
    presetProjection,
  ),
  setting(
    "settings.providers.list",
    empty,
    "Inspect chat and non-chat provider catalogs, authentication status and supported login methods; never stored credentials.",
    {},
    providerCatalog,
  ),
  setting(
    "settings.providers.refresh",
    empty,
    "Refresh provider/model catalogs through Pi; no generation or classification calls.",
    {},
    providerCatalog,
  ),
  setting(
    "settings.providers.login",
    Schema.Struct({ provider, authType: Schema.Literals(["api_key", "oauth"]) }),
    "Launch the existing provider API-key or OAuth flow on the originating device.",
    { provider: "openrouter", authType: "api_key" },
    Schema.Struct({ ...providerCatalog.fields, authorized: Schema.Boolean }),
    [
      "Requires user interaction. API keys/codes are entered in the existing secure dialog, never tool arguments. This waits for the actual flow; cancellation or failure is not authorization.",
    ],
  ),
  setting(
    "settings.providers.logout",
    Schema.Struct({ provider }),
    "Disconnect a provider through Pi's existing credential flow.",
    { provider: "openrouter" },
    providerCatalog,
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
    "settings.instructions.get",
    empty,
    "Read global custom instructions and all five worktree automation prompts/defaults.",
    {},
    Schema.Struct({ instructions: text, prompts: CakePrompts, defaults: CakePrompts }),
  ),
  setting(
    "settings.instructions.update",
    Schema.Struct({ instructions: text }),
    "Set global personal Project Session instructions; empty text clears them.",
    { instructions: "" },
    Schema.Struct({ instructions: text }),
  ),
  setting(
    "settings.prompts.update",
    Schema.Struct({
      key: Schema.Literals([
        "worktreeCommit",
        "worktreeRebaseConflict",
        "worktreePreserveConflict",
        "worktreeSquashConflict",
        "worktreeSquashMessage",
        "dictationCleanup",
      ]),
      value: Schema.NullOr(CakePrompts.fields.worktreeCommit),
    }),
    "Update one worktree automation prompt; null restores its default.",
    { key: "worktreeCommit", value: null },
    Schema.Struct({ prompts: CakePrompts }),
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
    "settings.dictation.get",
    empty,
    "Inspect originating desktop dictation installation, enablement and microphones; never audio.",
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
          "cancel-install",
          "remove",
          "install-punctuation",
          "remove-punctuation",
          "cancel-punctuation-install",
        ]),
      }),
      Schema.Struct({
        action: Schema.Literal("model-path"),
        path: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      }),
    ]),
    "Use the originating desktop's shared Voice & Dictation controls, including raw/local/utility text processing, explicit punctuation download/removal, recognition model and microphone selection.",
    { action: "enable", enabled: false },
    dictationView,
    [
      "Desktop only. Enabling dictation can request microphone permission and record into the focused writing surface. Installing downloads the existing native model; model-path uses existing native manifest/path validation.",
    ],
  ),
] as const;

export const AgentSettingsInvocation = Schema.Union(
  agentSettingsOperations.map((operation) => operation.invocation),
);
export type AgentSettingsInvocation = typeof AgentSettingsInvocation.Type;

export const agentSettingsSections = [
  ...cakeSettingsSections,
  {
    id: "speech",
    scope: "originating-desktop",
    writable: true,
    description: "Speech settings, persisted voices, refresh and default voice selection",
    commands: ["settings.speech.*"],
  },
  {
    id: "models",
    scope: "backend",
    writable: true,
    description:
      "Presets/default, utility model, image/classifier preferences; current chat uses session.set-model",
    commands: [
      "settings.models.get",
      "settings.models.set-utility",
      "settings.models.set-non-chat",
      "settings.presets.*",
      "session.set-model",
    ],
  },
  {
    id: "providers",
    scope: "backend",
    writable: true,
    description:
      "Catalog refresh and interactive API-key/OAuth login/logout; stored credentials are never returned",
    commands: ["settings.providers.*"],
  },
  {
    id: "pi",
    scope: "backend",
    writable: true,
    description:
      "Agent, execution/resources, codemode/tool-search, default agent model/reasoning, network/privacy and reload",
    commands: ["settings.pi.*"],
  },
  {
    id: "mcp",
    scope: "backend-or-calling-working-directory",
    writable: true,
    description:
      "Masked native MCP configuration and scope-aware reload. Project trust/access required",
    commands: ["settings.mcp.get", "settings.mcp.update", "settings.mcp.native"],
    limitations: [
      "Stored-secret reveal intentionally unavailable",
      "Native MCP login/logout/reconnect require an idle Project Session; a calling agent is busy. Cake Chat can target an explicitly named idle Project Session; submission does not confirm authorization",
    ],
  },
  {
    id: "instructions",
    scope: "backend",
    writable: true,
    description:
      "Global custom instructions, worktree automation prompts and speech cleanup prompt/reset",
    commands: ["settings.instructions.*", "settings.prompts.update"],
  },
  {
    id: "labels",
    scope: "backend",
    writable: true,
    description: "Global labels: add/edit/color/reorder/delete",
    commands: ["settings.labels.*"],
  },
  {
    id: "desktop",
    scope: "originating-desktop",
    writable: true,
    description: "Host selection/reload/reconnect and local-host browser sharing",
    commands: ["settings.desktop.*"],
    limitations: [
      "Browser clients unavailable; host switching may disconnect before receipt",
      "Sharing matches manual local-host-only availability",
    ],
  },
  {
    id: "dictation",
    scope: "originating-desktop",
    writable: true,
    description:
      "Mode, microphone, install/cancel, native model folder/remove; permission remains interactive",
    commands: ["settings.dictation.*"],
  },
] as const;

export const agentSettingsGuidance = [
  "These operations route through the originating Cake window/device and reuse manual Settings' typed Client/services. Backend settings remain on the selected backend; appearance/editor/hotkeys remain window-local via settings.get/update.",
  "Use settings.sections for coverage and scope, then exact settings.<operation>.help for schemas. Current chat model uses session.set-model, not an image/classifier preference.",
  "Cancellation does not undo a setting already saved. Interactive credentials and permissions remain user-owned; stored credentials are never returned.",
];
