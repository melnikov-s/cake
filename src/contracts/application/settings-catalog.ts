import { Schema } from "effect";
import { piSettingUpdateSchema, type PiSettingUpdate } from "../conversations/session-contract";
import { CakeModelChoice } from "../model-presets/cake-model-selection";
import { NonChatModelReference } from "../models/non-chat-model-data";
import { CakePrompts } from "./cake-prompt-data";
import { UtilityModel } from "./application-data";
import {
  CAKE_CHAT_CONTEXT_LIMIT_CHOICES,
  CAKE_CHAT_MEMORY_VIEW_CHOICES,
} from "../cake-chats/cake-chat-preferences";

/**
 * Data-only catalog of the scalar user settings that agents read and change by key through
 * settings.list/get/update. Each key executes through its existing backend authority (Cake's
 * application state or Pi's settings manager); the catalog only names and validates values.
 * Collection, credential, window and device settings keep their dedicated operations and are
 * listed in `settingsCatalogPointers` so one settings.list call discovers everything.
 */

/** Settings pages as labelled in the Settings UI. */
const settingsCatalogPages = [
  "Models",
  "Images",
  "Classifiers",
  "Agent",
  "Execution & resources",
  "Network & privacy",
  "Cake Chat",
  "Instructions & prompts",
  "Experimental",
  "Pi terminal",
] as const;
type SettingsCatalogPage = (typeof settingsCatalogPages)[number];

export interface SettingDefinition {
  readonly key: string;
  readonly page: SettingsCatalogPage;
  readonly label: string;
  readonly description: string;
  /** Validates an agent-supplied value with the same limits as the Settings control. */
  readonly value: Schema.ConstraintDecoder<unknown, never>;
  /** Human-readable value shape when the JSON Schema summary is not clear enough. */
  readonly type?: string;
}

const setting = (definition: SettingDefinition) => definition;

const modelChoiceType =
  '{source:"default"} | {source:"inherit"} | {source:"utility"} | {source:"preset",presetId} | {source:"model",model:{provider,modelId,thinkingLevel,fastMode?}}';

const promptKeys = [
  [
    "worktreeCommit",
    "Commit before merge",
    "Sent before merging a worktree with uncommitted work.",
  ],
  ["worktreeRebaseConflict", "Rebase conflict", "Sent when a worktree rebase conflicts."],
  ["worktreePreserveConflict", "Merge conflict", "Sent when a merge-preserving landing conflicts."],
  ["worktreeSquashConflict", "Squash conflict", "Sent when a squash landing conflicts."],
  ["worktreeSquashMessage", "Squash commit message", "Asks for a squash commit message."],
  [
    "dictationCleanup",
    "Utility cleanup prompt",
    "Voice & Dictation: instructions for optional utility-model cleanup of dictated text.",
  ],
] as const satisfies ReadonlyArray<readonly [keyof CakePrompts, string, string]>;
export const CakePromptKey = Schema.Literals(promptKeys.map(([key]) => key));

interface PiSettingMetadata {
  readonly page: SettingsCatalogPage;
  readonly label: string;
  readonly description: string;
}
const piMetadata = {
  defaultModel: {
    page: "Models",
    label: "Default agent model",
    description:
      "Pi's default provider/model for new Pi sessions without a Cake preset. Value {provider, modelId} from settings.providers.list.",
  },
  defaultThinkingLevel: {
    page: "Models",
    label: "Default reasoning",
    description: "Pi's default thinking level.",
  },
  autoCompact: {
    page: "Agent",
    label: "Auto-compact",
    description: "Compact Project Session context automatically near the model window.",
  },
  retryEnabled: {
    page: "Agent",
    label: "Automatic retry",
    description: "Retry transient provider failures.",
  },
  hideThinkingBlock: {
    page: "Agent",
    label: "Hide thinking",
    description: "Hide reasoning blocks.",
  },
  steeringMode: {
    page: "Agent",
    label: "Steering mode",
    description: "Deliver steering messages one at a time or all together.",
  },
  followUpMode: {
    page: "Agent",
    label: "Follow-up mode",
    description: "Deliver queued follow-up messages one at a time or all together.",
  },
  autoResizeImages: {
    page: "Agent",
    label: "Auto-resize images",
    description: "Resize large images before sending them to models.",
  },
  blockImages: {
    page: "Agent",
    label: "Block images",
    description: "Never send images to models.",
  },
  enableSkillCommands: {
    page: "Agent",
    label: "Skill commands",
    description: "Expose skills as slash commands.",
  },
  showCacheMissNotices: {
    page: "Agent",
    label: "Cache miss notices",
    description: "Show notices when a provider prompt cache misses.",
  },
  defaultTools: {
    page: "Execution & resources",
    label: "Default tools",
    description:
      "null restores Cake defaults (Pi's ordinary tools plus codemode), [] disables built-ins, plain names replace defaults, +name adds and -name removes. Codemode and tool search are the +codemode and +tool_search entries.",
  },
  codemodeInlineBudget: {
    page: "Execution & resources",
    label: "Codemode inline budget",
    description: "Characters of codemode output returned inline.",
  },
  shellPath: {
    page: "Execution & resources",
    label: "Shell path",
    description: "Shell used for bash; empty uses the default.",
  },
  shellCommandPrefix: {
    page: "Execution & resources",
    label: "Shell command prefix",
    description: "Prepended to every bash command; empty for none.",
  },
  npmCommand: {
    page: "Execution & resources",
    label: "npm command",
    description: "Command and arguments for package operations; [] uses npm.",
  },
  packages: {
    page: "Execution & resources",
    label: "Packages",
    description: "Pi package sources (paths, npm or git specifiers, or source objects).",
  },
  extensions: {
    page: "Execution & resources",
    label: "Extension paths",
    description: "Additional Pi extension paths.",
  },
  skills: {
    page: "Execution & resources",
    label: "Skill paths",
    description: "Additional Pi skill paths.",
  },
  prompts: {
    page: "Execution & resources",
    label: "Prompt paths",
    description: "Additional Pi prompt-template paths.",
  },
  transport: {
    page: "Network & privacy",
    label: "Transport",
    description: "Provider streaming transport.",
  },
  httpIdleTimeoutMs: {
    page: "Network & privacy",
    label: "HTTP idle timeout",
    description: "Milliseconds before an idle provider stream fails; 0 disables.",
  },
  defaultProjectTrust: {
    page: "Network & privacy",
    label: "Default project trust",
    description: "Whether project-local Pi resources load without asking.",
  },
  anthropicExtraUsageWarning: {
    page: "Network & privacy",
    label: "Anthropic extra usage warning",
    description: "Warn before Anthropic extra-usage billing.",
  },
  enableInstallTelemetry: {
    page: "Network & privacy",
    label: "Install telemetry",
    description: "Send Pi's anonymous install/update ping.",
  },
  mermaidRenderingMode: {
    page: "Pi terminal",
    label: "Mermaid rendering",
    description: "Pi terminal Mermaid rendering mode (not shown in Cake's Settings UI).",
  },
  collapseChangelog: {
    page: "Pi terminal",
    label: "Collapse changelog",
    description: "Collapse Pi's terminal changelog (not shown in Cake's Settings UI).",
  },
  quietStartup: {
    page: "Pi terminal",
    label: "Quiet startup",
    description: "Hide Pi's terminal startup details (not shown in Cake's Settings UI).",
  },
  doubleEscapeAction: {
    page: "Pi terminal",
    label: "Double-escape action",
    description: "Pi terminal double-Escape action (not shown in Cake's Settings UI).",
  },
  treeFilterMode: {
    page: "Pi terminal",
    label: "Tree filter",
    description: "Pi terminal session-tree filter (not shown in Cake's Settings UI).",
  },
} satisfies Record<PiSettingUpdate["key"], PiSettingMetadata>;

const piDefinitions = piSettingUpdateSchema.members.map((member) => {
  const key = member.fields.key.literal;
  return setting({
    key: `pi.${key}`,
    ...piMetadata[key],
    value:
      "value" in member.fields
        ? member.fields.value
        : Schema.Struct({ provider: member.fields.provider, modelId: member.fields.modelId }),
    ...(key === "packages"
      ? { type: "list of package source strings or {source, autoload?, extensions?, …}" }
      : null),
  });
});

export const settingsCatalog: readonly SettingDefinition[] = [
  setting({
    key: "cakeChat.contextLimitTokens",
    page: "Cake Chat",
    label: "Active context limit",
    description:
      "Global Cake Chat and every Project Chat summarize history at this token limit or the model window (minus the output reserve), whichever is smaller. Applies on the next message.",
    value: Schema.Literals(CAKE_CHAT_CONTEXT_LIMIT_CHOICES),
  }),
  setting({
    key: "cakeChat.memoryViewBytes",
    page: "Cake Chat",
    label: "History-view budget",
    description:
      "Bytes of OptMem history before consolidating toward half. Model-window admission may lower it.",
    value: Schema.Literals(CAKE_CHAT_MEMORY_VIEW_CHOICES),
  }),
  setting({
    key: "cakeChat.summarizationModel",
    page: "Cake Chat",
    label: "Summarization model",
    description:
      "Summarizes permanent-chat history when cache expires, is uncertain, or the active context limit is reached.",
    value: CakeModelChoice,
    type: modelChoiceType,
  }),
  setting({
    key: "cakeChat.subagentDefaultModel",
    page: "Cake Chat",
    label: "Subagent default model",
    description: "Used when Cake Chat starts a subagent without choosing a model.",
    value: CakeModelChoice,
    type: modelChoiceType,
  }),
  setting({
    key: "models.defaultPreset",
    page: "Models",
    label: "Default model preset",
    description:
      "Preset ID (from settings.models.get) used for new chats and sessions; null restores Pi's default model.",
    value: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
  }),
  setting({
    key: "models.utility",
    page: "Models",
    label: "Utility model",
    description: "Background-task model; null disables background utility calls.",
    value: Schema.NullOr(UtilityModel),
  }),
  setting({
    key: "models.imagePreference",
    page: "Images",
    label: "Preferred image model",
    description: "Advisory image-generation model {provider, modelId}; null clears it.",
    value: Schema.NullOr(NonChatModelReference),
  }),
  setting({
    key: "models.classifierPreference",
    page: "Classifiers",
    label: "Preferred classifier model",
    description: "Advisory classifier model {provider, modelId}; null clears it.",
    value: Schema.NullOr(NonChatModelReference),
  }),
  ...piDefinitions,
  setting({
    key: "instructions.global",
    page: "Instructions & prompts",
    label: "Global custom instructions",
    description:
      "Personal instructions for every coding Project Session; empty clears them. Trimmed when saved.",
    value: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  ...promptKeys.map(([key, label, description]) =>
    setting({
      key: `prompts.${key}`,
      page: "Instructions & prompts",
      label,
      description: `${description} null restores the default text.`,
      value: Schema.NullOr(CakePrompts.fields[key]),
    }),
  ),
  setting({
    key: "experimental.dynamicWorkflows",
    page: "Experimental",
    label: "Dynamic workflows",
    description: "Opt-in experimental orchestration scripts and background agents.",
    value: Schema.Boolean,
  }),
];

const settingsCatalogKeys: readonly string[] = settingsCatalog.map((definition) => definition.key);

/** Settings that agents change through other operations, or that are deliberately unavailable. */
export const settingsCatalogPointers = [
  {
    area: "Cake Chat instructions",
    page: "Cake Chat",
    operations: ["settings.cake-chat.get", "settings.cake-chat.update"],
    note: "Global Cake Chat only. Conflict-safe expectedInstructions merge.",
  },
  {
    area: "Project settings and Project Chat instructions",
    page: "Project settings",
    operations: [
      "project.settings.get",
      "project.settings.update",
      "projects.settings.get",
      "projects.settings.update",
      "settings.project-chat.get",
      "settings.project-chat.update",
    ],
    note: "Per registered Project.",
  },
  {
    area: "Model presets",
    page: "Models",
    operations: [
      "settings.models.get",
      "settings.presets.create",
      "settings.presets.update",
      "settings.presets.reorder",
      "settings.presets.remove",
    ],
    note: "The current chat's model uses session.set-model.",
  },
  {
    area: "Provider accounts",
    page: "Providers",
    operations: [
      "settings.providers.list",
      "settings.providers.info",
      "settings.providers.refresh",
      "settings.providers.login",
      "settings.providers.logout",
    ],
    note: "API keys and OAuth tokens are never readable or writable by agents; login opens the user's secure interactive dialog.",
  },
  {
    area: "MCP servers",
    page: "MCP servers",
    operations: ["settings.mcp.get", "settings.mcp.update", "settings.mcp.native"],
    note: "Stored secrets stay masked.",
  },
  {
    area: "Session labels",
    page: "Session labels",
    operations: ["settings.labels.get", "settings.labels.update"],
  },
  {
    area: "Widget packages",
    page: "Widget packages",
    operations: ["settings.widgets.list", "settings.widgets.install", "settings.widgets.remove"],
    note: "Install only with explicit user approval.",
  },
  {
    area: "Appearance, VS Code and hotkeys",
    page: "Appearance / VS Code / Hotkeys",
    operations: ["settings.window.get", "settings.window.update"],
    note: "Per window; executes in the Cake window showing the calling chat.",
  },
  {
    area: "Speech, dictation, host connection and browser sharing",
    page: "Voice & Dictation / Network & privacy",
    operations: [
      "settings.speech.get",
      "settings.speech.refresh-voices",
      "settings.speech.set-voice",
      "settings.dictation.get",
      "settings.dictation.update",
      "settings.desktop.get",
      "settings.desktop.sharing",
      "settings.desktop.reconnect",
      "settings.desktop.select-host",
    ],
    note: "Originating Cake desktop only. The ElevenLabs API key is never exposed.",
  },
] as const;

/** Settings UI controls agents cannot change, with the reason. */
export const settingsCatalogUnavailable = [
  {
    setting: "Provider API keys, OAuth tokens, the ElevenLabs API key and MCP stored secrets",
    reason: "Credentials are never returned or accepted as tool arguments.",
  },
  {
    setting: "Allow agent session navigation",
    reason: "A user-owned permission over agent actions; an agent must not grant itself access.",
  },
  {
    setting: "Pi extension enable/disable toggles",
    reason:
      "Discovered per installed extension on demand, without a change broadcast; use Settings → Extensions.",
  },
  {
    setting:
      "Drop-down Cake Chat shortcut, screen-capture shortcut/size and advanced speech-input tuning",
    reason:
      "Window-snapshot preferences registered with the OS by each desktop window; change them in Settings.",
  },
] as const;

export const SettingsListInput = Schema.Struct({
  page: Schema.optionalKey(Schema.Literals(settingsCatalogPages)),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export interface SettingsListInput extends Schema.Schema.Type<typeof SettingsListInput> {}

export const SettingsGetInput = Schema.Struct({ key: Schema.Literals(settingsCatalogKeys) });
export interface SettingsGetInput extends Schema.Schema.Type<typeof SettingsGetInput> {}

/** The value is validated against the key's own schema in the domain, giving a focused error. */
export const SettingsUpdateInput = Schema.Struct({
  key: Schema.Literals(settingsCatalogKeys),
  value: Schema.Json,
});
export interface SettingsUpdateInput extends Schema.Schema.Type<typeof SettingsUpdateInput> {}

const SettingEntry = Schema.Struct({
  key: Schema.String,
  page: Schema.String,
  label: Schema.String,
  type: Schema.String,
  value: Schema.Json,
  default: Schema.Json,
});

export const SettingsListOutput = Schema.Struct({
  settings: Schema.Array(Schema.Struct({ ...SettingEntry.fields, customized: Schema.Boolean })),
  otherSettings: Schema.Array(Schema.Json),
  unavailable: Schema.Array(Schema.Json),
});

export const SettingsGetOutput = Schema.Struct({
  ...SettingEntry.fields,
  description: Schema.String,
  schema: Schema.Json,
  effective: Schema.Json,
});

export const SettingsUpdateOutput = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  previous: Schema.Json,
  value: Schema.Json,
  effective: Schema.Json,
});

/** The JSON Schema keywords the value-shape summary reads; other keywords are ignored. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly enum?: ReadonlyArray<Schema.Json>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
  readonly format?: string;
  readonly items?: JsonSchemaNode;
  readonly properties?: { readonly [name: string]: JsonSchemaNode };
}
const JsonSchemaNode: Schema.Codec<JsonSchemaNode> = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  enum: Schema.optionalKey(Schema.Array(Schema.Json)),
  anyOf: Schema.optionalKey(Schema.Array(Schema.suspend(() => JsonSchemaNode))),
  minimum: Schema.optionalKey(Schema.Number),
  maximum: Schema.optionalKey(Schema.Number),
  maxLength: Schema.optionalKey(Schema.Number),
  format: Schema.optionalKey(Schema.String),
  items: Schema.optionalKey(Schema.suspend(() => JsonSchemaNode)),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend(() => JsonSchemaNode),
    ),
  ),
});

function summarizeNode(node: JsonSchemaNode): string {
  const { anyOf, enum: choices, type, minimum, maximum } = node;
  if (choices) return choices.map((choice) => JSON.stringify(choice)).join(" | ");
  if (anyOf) return anyOf.map(summarizeNode).join(" | ");
  if (type === "boolean" || type === "null") return type;
  if (type === "integer" || type === "number") {
    if (minimum !== undefined && maximum !== undefined) return `${type} ${minimum}–${maximum}`;
    return minimum === undefined ? type : `${type} ≥ ${minimum}`;
  }
  if (type === "string") {
    if (node.format === "uuid") return "uuid";
    return node.maxLength === undefined ? "string" : `string (≤${node.maxLength} chars)`;
  }
  if (type === "array") return `list of ${node.items ? summarizeNode(node.items) : "value"}`;
  if (type === "object" && node.properties)
    return `{${Object.entries(node.properties)
      .map(([name, value]) => `${name}: ${summarizeNode(value)}`)
      .join(", ")}}`;
  return "value";
}

/** The key's value schema as JSON Schema (draft-07), shown by settings.get. */
export function settingJsonSchema(definition: SettingDefinition): Schema.Json {
  return Schema.decodeUnknownSync(Schema.Json)(
    Schema.toStandardJSONSchemaV1(definition.value)["~standard"].jsonSchema.input({
      target: "draft-07",
    }),
  );
}

/** Compact value-shape text for settings.list, derived from the key's JSON Schema. */
export function settingTypeSummary(definition: SettingDefinition): string {
  return (
    definition.type ??
    summarizeNode(Schema.decodeUnknownSync(JsonSchemaNode)(settingJsonSchema(definition)))
  );
}
