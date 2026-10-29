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
 * named in `settingsElsewhere`. Discovery is progressive: categories first, then one category.
 */

/** Categories match the Settings UI pages, plus Pi's terminal-only settings. */
export const settingsCategories = [
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
type SettingsCategory = (typeof settingsCategories)[number];

export interface SettingDefinition {
  readonly key: string;
  readonly category: SettingsCategory;
  readonly label: string;
  readonly description: string;
  /** Validates an agent-supplied value with the same limits as the Settings control. */
  readonly value: Schema.ConstraintDecoder<unknown, never>;
  /** Human-readable value shape when the JSON Schema summary is not clear enough. */
  readonly type?: string;
}

const setting = (definition: SettingDefinition) => definition;

const modelChoiceType =
  "{source:default|inherit|utility} | {source:preset,presetId} | {source:model,model:{provider,modelId,thinkingLevel,fastMode?}}";

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
  readonly category: SettingsCategory;
  readonly label: string;
  readonly description: string;
}
const piMetadata = {
  defaultModel: {
    category: "Models",
    label: "Default agent model",
    description:
      "Pi's default provider/model for new Pi sessions without a Cake preset. Value {provider, modelId} from settings.providers.list.",
  },
  defaultThinkingLevel: {
    category: "Models",
    label: "Default reasoning",
    description: "Pi's default thinking level.",
  },
  autoCompact: {
    category: "Agent",
    label: "Auto-compact",
    description: "Compact Project Session context automatically near the model window.",
  },
  retryEnabled: {
    category: "Agent",
    label: "Automatic retry",
    description: "Retry transient provider failures.",
  },
  hideThinkingBlock: {
    category: "Agent",
    label: "Hide thinking",
    description: "Hide reasoning blocks.",
  },
  steeringMode: {
    category: "Agent",
    label: "Steering mode",
    description: "Deliver steering messages one at a time or all together.",
  },
  followUpMode: {
    category: "Agent",
    label: "Follow-up mode",
    description: "Deliver queued follow-up messages one at a time or all together.",
  },
  autoResizeImages: {
    category: "Agent",
    label: "Auto-resize images",
    description: "Resize large images before sending them to models.",
  },
  blockImages: {
    category: "Agent",
    label: "Block images",
    description: "Never send images to models.",
  },
  enableSkillCommands: {
    category: "Agent",
    label: "Skill commands",
    description: "Expose skills as slash commands.",
  },
  showCacheMissNotices: {
    category: "Agent",
    label: "Cache miss notices",
    description: "Show notices when a provider prompt cache misses.",
  },
  defaultTools: {
    category: "Execution & resources",
    label: "Default tools",
    description:
      "null restores Cake defaults (Pi's ordinary tools plus codemode), [] disables built-ins, plain names replace defaults, +name adds and -name removes. Codemode and tool search are the +codemode and +tool_search entries.",
  },
  codemodeInlineBudget: {
    category: "Execution & resources",
    label: "Codemode inline budget",
    description: "Characters of codemode output returned inline.",
  },
  shellPath: {
    category: "Execution & resources",
    label: "Shell path",
    description: "Shell used for bash; empty uses the default.",
  },
  shellCommandPrefix: {
    category: "Execution & resources",
    label: "Shell command prefix",
    description: "Prepended to every bash command; empty for none.",
  },
  npmCommand: {
    category: "Execution & resources",
    label: "npm command",
    description: "Command and arguments for package operations; [] uses npm.",
  },
  packages: {
    category: "Execution & resources",
    label: "Packages",
    description: "Pi package sources (paths, npm or git specifiers, or source objects).",
  },
  extensions: {
    category: "Execution & resources",
    label: "Extension paths",
    description: "Additional Pi extension paths.",
  },
  skills: {
    category: "Execution & resources",
    label: "Skill paths",
    description: "Additional Pi skill paths.",
  },
  prompts: {
    category: "Execution & resources",
    label: "Prompt paths",
    description: "Additional Pi prompt-template paths.",
  },
  transport: {
    category: "Network & privacy",
    label: "Transport",
    description: "Provider streaming transport.",
  },
  httpIdleTimeoutMs: {
    category: "Network & privacy",
    label: "HTTP idle timeout",
    description: "Milliseconds before an idle provider stream fails; 0 disables.",
  },
  defaultProjectTrust: {
    category: "Network & privacy",
    label: "Default project trust",
    description: "Whether project-local Pi resources load without asking.",
  },
  anthropicExtraUsageWarning: {
    category: "Network & privacy",
    label: "Anthropic extra usage warning",
    description: "Warn before Anthropic extra-usage billing.",
  },
  enableInstallTelemetry: {
    category: "Network & privacy",
    label: "Install telemetry",
    description: "Send Pi's anonymous install/update ping.",
  },
  mermaidRenderingMode: {
    category: "Pi terminal",
    label: "Mermaid rendering",
    description: "Pi terminal Mermaid rendering mode (not shown in Cake's Settings UI).",
  },
  collapseChangelog: {
    category: "Pi terminal",
    label: "Collapse changelog",
    description: "Collapse Pi's terminal changelog (not shown in Cake's Settings UI).",
  },
  quietStartup: {
    category: "Pi terminal",
    label: "Quiet startup",
    description: "Hide Pi's terminal startup details (not shown in Cake's Settings UI).",
  },
  doubleEscapeAction: {
    category: "Pi terminal",
    label: "Double-escape action",
    description: "Pi terminal double-Escape action (not shown in Cake's Settings UI).",
  },
  treeFilterMode: {
    category: "Pi terminal",
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
      ? { type: "[source | {source,autoload?,extensions?,skills?,prompts?,themes?}]" }
      : null),
  });
});

export const settingsCatalog: readonly SettingDefinition[] = [
  setting({
    key: "cakeChat.contextLimitTokens",
    category: "Cake Chat",
    label: "Active context limit",
    description:
      "Global Cake Chat and every Project Chat summarize history at this token limit or the model window (minus the output reserve), whichever is smaller. Applies on the next message.",
    value: Schema.Literals(CAKE_CHAT_CONTEXT_LIMIT_CHOICES),
  }),
  setting({
    key: "cakeChat.memoryViewBytes",
    category: "Cake Chat",
    label: "History-view budget",
    description:
      "Bytes of OptMem history before consolidating toward half. Model-window admission may lower it.",
    value: Schema.Literals(CAKE_CHAT_MEMORY_VIEW_CHOICES),
  }),
  setting({
    key: "cakeChat.summarizationModel",
    category: "Cake Chat",
    label: "Summarization model",
    description:
      "Summarizes permanent-chat history when cache expires, is uncertain, or the active context limit is reached.",
    value: CakeModelChoice,
    type: modelChoiceType,
  }),
  setting({
    key: "cakeChat.subagentDefaultModel",
    category: "Cake Chat",
    label: "Subagent default model",
    description: "Used when Cake Chat starts a subagent without choosing a model.",
    value: CakeModelChoice,
    type: modelChoiceType,
  }),
  setting({
    key: "models.defaultPreset",
    category: "Models",
    label: "Default model preset",
    description:
      "Preset ID (from settings.models.get) used for new chats and sessions; null restores Pi's default model.",
    value: Schema.NullOr(Schema.String.check(Schema.isUUID(4))),
  }),
  setting({
    key: "models.utility",
    category: "Models",
    label: "Utility model",
    description: "Background-task model; null disables background utility calls.",
    value: Schema.NullOr(UtilityModel),
  }),
  setting({
    key: "models.imagePreference",
    category: "Images",
    label: "Preferred image model",
    description: "Advisory image-generation model {provider, modelId}; null clears it.",
    value: Schema.NullOr(NonChatModelReference),
  }),
  setting({
    key: "models.classifierPreference",
    category: "Classifiers",
    label: "Preferred classifier model",
    description: "Advisory classifier model {provider, modelId}; null clears it.",
    value: Schema.NullOr(NonChatModelReference),
  }),
  ...piDefinitions,
  setting({
    key: "instructions.global",
    category: "Instructions & prompts",
    label: "Global custom instructions",
    description:
      "Personal instructions for every coding Project Session; empty clears them. Trimmed when saved.",
    value: Schema.String.check(Schema.isMaxLength(16_384)),
  }),
  ...promptKeys.map(([key, label, description]) =>
    setting({
      key: `prompts.${key}`,
      category: "Instructions & prompts",
      label,
      description: `${description} null restores the default text.`,
      value: Schema.NullOr(CakePrompts.fields[key]),
    }),
  ),
  setting({
    key: "experimental.dynamicWorkflows",
    category: "Experimental",
    label: "Dynamic workflows",
    description: "Opt-in experimental orchestration scripts and background agents.",
    value: Schema.Boolean,
  }),
];

/** Settings changed through dedicated operations: collections, credentials, window, device. */
export const settingsElsewhere = [
  ["Model presets", "settings.models.get, settings.presets.*"],
  ["Provider accounts (credentials never exposed)", "settings.providers.*"],
  ["MCP servers (secrets masked)", "settings.mcp.*"],
  ["Session labels", "settings.labels.*"],
  ["Widget packages (explicit user approval)", "settings.widgets.*"],
  ["Cake Chat / Project Chat instructions", "settings.cake-chat.*, settings.project-chat.*"],
  [
    "Project settings",
    "project.settings.* (Project Session, own Project), projects.settings.* (global Cake Chat, any Project)",
  ],
  ["Appearance, VS Code, hotkeys (this window)", "settings.window.*"],
  [
    "Speech, dictation, host, sharing (this desktop)",
    "settings.speech.*, settings.dictation.*, settings.desktop.*",
  ],
  ["Reload Pi resources", "settings.pi.reload"],
] as const;

/** Settings UI controls agents cannot change. */
export const settingsNotAgentWritable =
  "Provider API keys/OAuth tokens, the ElevenLabs key and MCP secrets (credentials); Allow agent session navigation (user-owned permission); Pi extension toggles; OS shortcuts, screen-capture size and speech-input tuning (per-window, OS-registered).";

const settingKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));

export const SettingsListInput = Schema.Struct({
  category: Schema.optionalKey(Schema.Literals(settingsCategories)),
  query: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
});
export interface SettingsListInput extends Schema.Schema.Type<typeof SettingsListInput> {}

/** Keys are validated against the catalog in the domain, keeping the schema small. */
export const SettingsGetInput = Schema.Struct({ key: settingKey });
export interface SettingsGetInput extends Schema.Schema.Type<typeof SettingsGetInput> {}

/** The value is validated against the key's own schema in the domain, giving a focused error. */
export const SettingsUpdateInput = Schema.Struct({ key: settingKey, value: Schema.Json });
export interface SettingsUpdateInput extends Schema.Schema.Type<typeof SettingsUpdateInput> {}

const SettingsOverview = Schema.Struct({
  categories: Schema.Array(
    Schema.Struct({ category: Schema.String, settings: Schema.Int, changed: Schema.Int }),
  ),
  elsewhere: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  notAgentWritable: Schema.String,
});

const SettingsRows = Schema.Struct({
  settings: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      value: Schema.Json,
      /** Present only when the value differs from the default. */
      default: Schema.optionalKey(Schema.Json),
      type: Schema.String,
    }),
  ),
});

export const SettingsListOutput = Schema.Union([SettingsOverview, SettingsRows]);

export const SettingsGetOutput = Schema.Struct({
  key: Schema.String,
  category: Schema.String,
  label: Schema.String,
  description: Schema.String,
  type: Schema.String,
  value: Schema.Json,
  default: Schema.Json,
  effective: Schema.optionalKey(Schema.Json),
});

export const SettingsUpdateOutput = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  previous: Schema.Json,
  value: Schema.Json,
  effective: Schema.optionalKey(Schema.Json),
});

/** The JSON Schema keywords the value-shape summary reads; other keywords are ignored. */
interface JsonSchemaNode {
  readonly type?: string;
  readonly enum?: ReadonlyArray<Schema.Json>;
  readonly anyOf?: ReadonlyArray<JsonSchemaNode>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly maxLength?: number;
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
  items: Schema.optionalKey(Schema.suspend(() => JsonSchemaNode)),
  properties: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.suspend(() => JsonSchemaNode),
    ),
  ),
});

/** Terse value shape, e.g. `sse|auto`, `int 0–100000`, `string≤4096`, `{provider,modelId}`. */
function summarizeNode(node: JsonSchemaNode): string {
  const { anyOf, enum: choices, type, minimum, maximum } = node;
  if (choices) return choices.map((choice) => String(choice)).join("|");
  if (anyOf) return anyOf.map(summarizeNode).join(" | ");
  if (type === "boolean" || type === "null") return type;
  if (type === "integer" || type === "number") {
    const name = type === "integer" ? "int" : "number";
    if (minimum !== undefined && maximum !== undefined) return `${name} ${minimum}–${maximum}`;
    return minimum === undefined ? name : `${name}≥${minimum}`;
  }
  if (type === "string")
    return node.maxLength === undefined ? "string" : `string≤${node.maxLength}`;
  if (type === "array") return `[${node.items ? summarizeNode(node.items) : "value"}]`;
  if (type === "object" && node.properties) return `{${Object.keys(node.properties).join(",")}}`;
  return "value";
}

/** Compact value-shape text for settings.list/get, derived from the key's JSON Schema. */
export function settingTypeSummary(definition: SettingDefinition): string {
  return (
    definition.type ??
    summarizeNode(
      Schema.decodeUnknownSync(JsonSchemaNode)(
        Schema.toStandardJSONSchemaV1(definition.value)["~standard"].jsonSchema.input({
          target: "draft-07",
        }),
      ),
    )
  );
}
