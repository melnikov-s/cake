import { SideSessionFork } from "../cake-chats/side-session-fork";
import { themeOperationDefinitions } from "../themes/theme-operations";
import { PresetContext } from "../model-presets/preset-context";
import { ResultDelivery, resultDeliveryGuidance } from "../conversations/result-delivery";
import { Effect, Schema } from "effect";
import { CakeControlTool } from "../cake-chats/cake-chat-data";
import { AgentSessionAbortInput } from "./backend-agent-control";
import { backendAgentTools } from "./backend-agent-tools";
import {
  agentSettingsTool,
  backendAgentSettingsTools,
  isBackendAgentSetting,
} from "./agent-settings-tools";
import { agentSettingsOperations } from "./agent-settings-schema";
import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
  windowSettingsGetHelp,
  windowSettingsUpdateHelp,
} from "./cake-settings-schema";
import { QueuedSessionCommand } from "../conversations/session-query-data";
import { SESSION_TITLE_MAX_LENGTH, thinkingLevelSchema } from "../conversations/session-contract";
import { messageRefsSchema } from "../conversations/message-reference";
import { inputRefsSchema } from "../conversations/task-input";
import { promptFilesSchema, promptFilesGuidance } from "../conversations/prompt-files";
import { CakeModelSelection } from "../model-presets/cake-model-selection";
import { SessionNavigationInput, sessionNavigationHelp } from "./session-navigation";
import { PROJECT_TODO_AUTO_COMPLETION_RULE } from "../projects/project-todos";
import {
  AgentPendingListInput,
  AgentPendingReadInput,
} from "../conversations/agent-pending-messages";

const bounded = (min: number, max: number) =>
  Schema.String.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const trimmed = (min: number, max: number) =>
  Schema.Trim.check(Schema.isMinLength(min), Schema.isMaxLength(max));
const sessionIdTargetSchema = Schema.Struct({ sessionId: bounded(1, 256) });
const emptyArgumentsSchema = Schema.Struct({});

const createSessionArgs = Schema.Struct({
  promptFiles: Schema.optionalKey(promptFilesSchema),
  messageRefs: Schema.optionalKey(messageRefsSchema),
  inputRefs: Schema.optionalKey(inputRefsSchema),
  workspacePath: bounded(1, 4096),
  name: trimmed(1, 500),
  initialPrompt: trimmed(1, 100000),
  model: Schema.optionalKey(
    Schema.Struct({
      preset: Schema.optionalKey(PresetContext),
      provider: trimmed(1, 256),
      modelId: trimmed(1, 512),
      thinkingLevel: thinkingLevelSchema.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("off" as const)),
      ),
      fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
  ),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
  markdown: Schema.optionalKey(Schema.Boolean),
  resultDelivery: Schema.optionalKey(ResultDelivery),
});
const createDraftSessionArgs = Schema.Struct({
  workspacePath: bounded(1, 4096),
  name: trimmed(1, 500),
  initialPrompt: trimmed(1, 100000),
  model: Schema.optionalKey(
    Schema.Struct({
      preset: Schema.optionalKey(PresetContext),
      provider: trimmed(1, 256),
      modelId: trimmed(1, 512),
      thinkingLevel: thinkingLevelSchema.pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("off" as const)),
      ),
      fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    }),
  ),
});
/** Data-only window controls shared by chat runtime discovery and renderer execution. */
export const windowControlDefinitions = {
  ...themeOperationDefinitions,
  "settings.window.get": {
    command: "settings.window.get",
    args: CakeSettingsGetInput,
    scope: "global",
    discovery: windowSettingsGetHelp,
  },
  "settings.window.update": {
    command: "settings.window.update",
    args: CakeSettingsUpdateInput,
    scope: "global",
    discovery: windowSettingsUpdateHelp,
  },
  "app.state": {
    command: "app.state",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Inspect window/view metadata",
    },
  },
  "app.user-selection": {
    command: "app.user-selection",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Read highlighted Cake text",
      result: "The currently selected text, or no text if nothing is highlighted in Cake.",
    },
  },
  "app.workspace": {
    command: "app.workspace",
    args: Schema.Struct({
      visible: Schema.optionalKey(Schema.Boolean),
      mode: Schema.optionalKey(Schema.Literals(["todos", "sessions"])),
    }),
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Inspect/change Workspace pane",
    },
  },
  "app.home": {
    command: "app.home",
    args: emptyArgumentsSchema,
    scope: "global",
    discovery: {
      topic: "app",
      summary: "Open Project Chat home",
    },
  },
  "notifications.send": {
    command: "notifications.send",
    args: Schema.Struct({
      title: trimmed(1, 256),
      body: trimmed(1, 2000),
      level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
        Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
      ),
    }),
    scope: "global",
    discovery: {
      topic: "notifications",
      summary: "Send system notification",
    },
  },
  "sessions.queue-command": {
    command: "sessions.queue-command",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      ...QueuedSessionCommand.fields,
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Queue command between responses",
      guidance: [
        "Inspect sessions.commands for queueable commands. /compact accepts instructions; /toolcompact takes no arguments and uses the latest completed assistant response when executed.",
        "Commands share the follow-up queue with messages and preserve its order. Use sessions.pending, sessions.reorder, or sessions.cancel-queued to inspect, reorder or cancel pending work.",
        "The receipt confirms acceptance, not completion. Commands cannot be steered into a running response. Pending commands are process-lifetime state, not durable scheduling.",
      ],
      examples: [
        {
          input: {
            sessionId: "parent-session-id",
            command: "/toolcompact",
          },
        },
      ],
    },
  },
  "sessions.reorder": {
    command: "sessions.reorder",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      itemId: Schema.String.check(Schema.isUUID(4)),
      position: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Reorder within queue lane (one-based)",
    },
  },
  "sessions.pending": {
    command: "sessions.pending",
    args: AgentPendingListInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "List queued input metadata",
    },
  },
  "sessions.pending-info": {
    command: "sessions.pending-info",
    args: AgentPendingReadInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Read queued input",
    },
  },

  "sessions.update-queued": {
    command: "sessions.update-queued",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
      text: Schema.String,
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Edit queued user text; do not send",
    },
  },
  "sessions.cancel-queued": {
    command: "sessions.cancel-queued",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Cancel queued input",
    },
  },
  "sessions.steer-queued": {
    command: "sessions.steer-queued",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Move queued input to steering",
    },
  },
  "sessions.send-now": {
    command: "sessions.send-now",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      partId: bounded(1, 256),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Stop and send queued input",
    },
  },
  "sessions.clear-queue": {
    command: "sessions.clear-queue",
    args: sessionIdTargetSchema,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Clear queued inputs",
    },
  },
  "sessions.fork": {
    command: "sessions.fork",
    args: SideSessionFork,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary:
        "Investigate read-only in a context-forked Side Session (inline/side context fork) from this permanent chat, in a new Cake-managed worktree. Starts asynchronously; leaves the source open and unchanged.",
      guidance: [
        "For investigation/research with useful existing context where implementation is not yet clear. Never use sessions.fork for coding delegation: implementation/code changes default to sessions.create, a fresh independent Project Session. If code changes become needed, return findings for handoff to a fresh Project Session; never silently expand research into coding. No family children.",
        "workspacePath must be an authorized registered Project root; a Project Chat can use only its own project. worktreeName is required. entryId optionally selects an exchange; otherwise uses the latest completed reply before this tool call. If no settled reply exists, the operation fails rather than launching a fresh task.",
        "Investigation with an explicitly requested different model uses a private subagent directly with that model, not sessions.fork or sessions.create as a research workaround. A private subagent is also authorized when existing context is not helpful; otherwise use the contextual fork for investigation.",
        "Uses Pi Durable's native fork, inheriting conversation context, model and originating tool permissions. initialPrompt is the read-only assignment, not a replacement for inherited history. The current unfinished exchange is outside the settled fork boundary: include any task specifics from it. The context fork has its own executable identity and tools bound to its managed worktree; tool availability is not permission to code.",
        "Launch asynchronously/non-blocking with resultDelivery: notification by default, reply for owed answers/dependencies. Omit model overrides unless requested. Minimize cross-session chatter; completion is automatic.",
        resultDeliveryGuidance,
      ],
    },
  },
  "sessions.create": {
    command: "sessions.create",
    args: createSessionArgs,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Launch independent Project Session",
      guidance: [
        'Default for implementation/code changes ("do work"): create a fresh independent Project Session with its own scoped task and Cake-managed worktree, never sessions.fork or family children. workspacePath must be an authorized registered Project root; Project Chat targets only its own project. Pass worktreeName and a focused initialPrompt with meaningful context, constraints, relevant findings and acceptance checks; fresh sessions do not inherit conversation history.',
        "Investigation with useful existing context where implementation is not yet clear uses sessions.fork read-only. If code changes become needed, hand off findings here; do not silently expand research into coding. Investigation with an explicitly requested different model uses a private subagent directly with that model, not sessions.create as a research workaround; unhelpful existing context also permits a private subagent. Otherwise use the contextual fork for investigation.",
        "Launch asynchronously/non-blocking. Minimize cross-session chatter; completion is automatic.",
        "Omit model unless requested; configured default preset supplies complete settings, falling back to caller only if no default.",
        promptFilesGuidance,
        "Pass exact attachment IDs from input metadata or attachments.list in inputRefs to forward without reading. Use attachments.read only when you want to inspect the content yourself.",
        resultDeliveryGuidance,
        "Defaults to notification. Later unrelated local user turns never notify the creator.",
      ],
      examples: [
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication follow-up",
            initialPrompt:
              "Implement the scoped authentication changes with focused regression tests.",
            worktreeName: "authentication-follow-up",
            resultDelivery: "notification",
          },
          description: "Use the configured default model.",
        },
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication implementation",
            initialPrompt:
              "Implement the scoped authentication changes with focused regression tests.",
            worktreeName: "authentication-implementation",
            resultDelivery: "notification",
            model: "Sol",
          },
          description:
            "Only when the user asks for a specific model: select a configured preset by name.",
        },
      ],
    },
    discoveryArgs: Schema.Struct({
      ...createSessionArgs.fields,
      model: Schema.optionalKey(CakeModelSelection),
    }),
  },
  "sessions.create-draft": {
    command: "sessions.create-draft",
    args: createDraftSessionArgs,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Save unstarted session draft",
      guidance: [
        "Omit model unless the user explicitly asks for a specific model. When omitted, the draft uses the configured default model preset's complete settings (provider, model, thinking level, and Fast mode; see models.list), not the calling Cake Chat's current model. Only when no default preset is configured does it use the calling Cake Chat's current settings.",
      ],
      examples: [
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication follow-up",
            initialPrompt: "Review the authentication flow and propose the next changes.",
          },
          description: "Use the configured default model.",
        },
        {
          input: {
            workspacePath: "/path/to/project",
            name: "Authentication review",
            initialPrompt: "Review the authentication flow.",
            model: "Sol",
          },
          description:
            "Only when the user asks for a specific model: select a configured preset by name.",
        },
      ],
    },
    discoveryArgs: Schema.Struct({
      ...createDraftSessionArgs.fields,
      model: Schema.optionalKey(CakeModelSelection),
    }),
  },
  "sessions.abort": {
    command: "sessions.abort",
    args: AgentSessionAbortInput,
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Stop active turn",
      guidance: [
        "Stop is stopped, not failed/needs-attention; owed result settles silently. Include a short reason.",
      ],
    },
  },
  "sessions.rename": {
    command: "sessions.rename",
    args: Schema.Struct({
      ...sessionIdTargetSchema.fields,
      title: trimmed(1, SESSION_TITLE_MAX_LENGTH),
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Rename target",
    },
  },
  "sessions.resolve": {
    command: "sessions.resolve",
    args: Schema.Struct({
      targets: Schema.Array(
        Schema.Struct({
          kind: Schema.Literal("project"),
          sessionId: bounded(1, 256),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(10000)),
      resolved: Schema.Boolean,
    }),
    scope: "global",
    discovery: {
      topic: "sessions",
      summary: "Resolve/restore explicit targets",
      guidance: [
        `${PROJECT_TODO_AUTO_COMPLETION_RULE} Resolving all actual session associations completes linked to-dos in Project Chat and global Cake Chat lists. Source/report links do not block completion; source-only items stay open. Restore never reopens to-dos, and marking a to-do done never resolves sessions.`,
      ],
    },
  },
  "sessions.open": {
    command: "sessions.open",
    args: SessionNavigationInput,
    scope: "global",
    discovery: sessionNavigationHelp,
  },
} as const;

export function cakeChatControlTools(): CakeControlTool[] {
  return [
    ...backendAgentTools(),
    ...backendAgentSettingsTools(),
    // Device settings run in the Cake window showing the calling permanent chat.
    ...agentSettingsOperations
      .filter((definition) => !isBackendAgentSetting(definition.command))
      .map(agentSettingsTool),
    ...Object.values(windowControlDefinitions).map((definition) =>
      Schema.decodeUnknownSync(CakeControlTool)({
        examples: [],
        result: "A bounded authoritative Cake application result.",
        ...definition.discovery,
        command: definition.command,
        parameters: Schema.toStandardJSONSchemaV1(
          "discoveryArgs" in definition ? definition.discoveryArgs : definition.args,
        )["~standard"].jsonSchema.input({ target: "draft-07" }),
      }),
    ),
  ];
}
