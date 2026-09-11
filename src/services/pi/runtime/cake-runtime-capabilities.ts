import {
  DefaultResourceLoader,
  type AgentSession,
  type InlineExtension,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { Effect, Option, Schema } from "effect";
import {
  CakeModelSelection,
  type ExplicitCakeModelSelection,
} from "../../../domain/model-presets/cake-model-selection";
import type { SubagentTaskInput as DomainSubagentTaskInput } from "../../../domain/subagents/subagent-data";
import {
  CakeSettingsGetInput,
  CakeSettingsUpdateInput,
} from "../../../domain/application/cake-settings-schema";
import { jsonObjectSchema, type JsonObject, type JsonValue } from "../../../ipc/json-contract";
import { SESSION_TITLE_MAX_LENGTH } from "../../../ipc/session-contract";
import { artifactRecordSchema, type CakeArtifactV1 } from "../../../ipc/artifact-contract";
import { createCakeArtifactExtension } from "./artifact-extension";
import { createCakeArtifactOperations } from "./cake-artifact-operations";
import { createCakeModelOperations } from "./cake-model-operations";
import { createCakeVscodeOperations } from "./cake-vscode-operations";
import { createCakeWorktreeOperations } from "./cake-worktree-operations";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
  type CakeOperationDefinition,
} from "./cake-operation-registry";
import { loadCakeRuntimeResourceLoader } from "./cake-runtime-resources";
import { detectGitWorktree, worktreeSystemPrompt } from "./worktree-system-prompt";
import cakeChatPromptTemplate from "./prompts/cake-chat.md?raw";
import commonPromptTemplate from "./prompts/common.md?raw";
import interviewPromptTemplate from "./prompts/interview.md?raw";
import projectInteractionPromptTemplate from "./prompts/project-interaction.md?raw";
import projectPromptTemplate from "./prompts/project.md?raw";
import { renderPromptTemplate } from "./prompt-template";
import {
  parallelSubagentSchema,
  subagentTaskSchema,
  type SubagentTaskInput,
} from "./subagent-contract";
import { formatUnknown } from "./session-projection";
import type { CakeRuntimeOptions } from "./cake-runtime";

const commonPrompt = renderPromptTemplate(commonPromptTemplate);
const interviewPrompt = renderPromptTemplate(interviewPromptTemplate);
const projectInteractionPrompt = renderPromptTemplate(projectInteractionPromptTemplate, {
  interviewPrompt,
});
const cakeChatSystemPrompt = renderPromptTemplate(cakeChatPromptTemplate, {
  commonPrompt,
  interviewPrompt,
});
const cakeProjectSystemPrompt = renderPromptTemplate(projectPromptTemplate, {
  commonPrompt,
  projectInteractionPrompt,
});

export const projectSessionCreateInputSchema = Schema.Struct({
  name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  initialPrompt: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
  model: Schema.optionalKey(CakeModelSelection),
  worktreeName: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/)),
  ),
});
type ProjectSessionCreateInput = typeof projectSessionCreateInputSchema.Type;

export interface GlobalControlTool {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  parameters: JsonObject;
  examples?: readonly { input?: JsonObject; description?: string }[];
  result?: string;
  limitations?: readonly string[];
}

export function createGlobalControlOperations(
  control: NonNullable<CakeRuntimeOptions["globalControl"]>,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
): CakeOperationDefinition[] {
  return control.tools.map((tool) => ({
    command: tool.command,
    topic: tool.topic,
    summary: tool.summary,
    guidance: tool.guidance,
    inputSchema: jsonObjectSchema,
    inputJsonSchema: tool.parameters,
    examples: tool.examples ?? [],
    result: tool.result ?? "A bounded result from Cake's authoritative application control.",
    limitations: tool.limitations,
    async execute(input, context) {
      const decodedInput = Schema.decodeUnknownSync(jsonObjectSchema)(input);
      const argumentsValue = ["sessions.create", "sessions.create-draft"].includes(tool.command)
        ? {
            ...decodedInput,
            model: resolveModel(
              decodedInput.model === undefined
                ? undefined
                : Schema.decodeUnknownSync(CakeModelSelection)(decodedInput.model),
            ),
          }
        : decodedInput;
      return control.invoke({ name: tool.command, arguments: argumentsValue }, context.signal);
    },
  }));
}

export function createAgentControlOperations(
  control: NonNullable<CakeRuntimeOptions["agentControl"]>,
  parentSessionId: () => string | undefined,
  resolveModel: (selection: CakeModelSelection | undefined) => ExplicitCakeModelSelection,
): CakeOperationDefinition[] {
  const promptSchema = Schema.Struct({
    handleId: Schema.String.check(Schema.isUUID()),
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(262_144)),
  });
  const handleSchema = Schema.Struct({ handleId: Schema.String.check(Schema.isUUID()) });
  const guidance = [
    "Subagents are private, hidden, bounded workers—not full Project Sessions. A request for a child session, related session, or Session Family member is not subagent delegation; use sessions.create-child instead.",
    "Use subagents only when the user explicitly requested delegation, subagents, or parallel agent work.",
    "Use subagents.run for ordinary single-task delegation so the result returns in the same tool call. Use subagents.start only for explicitly background work; Cake automatically delivers its completion, so do not poll it.",
    "subagents.wait is an optional synchronization barrier for background work, not a required completion mechanism.",
    "Each subagent has read, bash, edit, and write tools, but no Cake controls, project instructions, skills, or recursive delegation.",
    "Handles are parent-owned and remain available for follow-up until explicitly closed; parallel batches contain at most eight tasks.",
    "When model is omitted, a subagent inherits the calling session's current model, thinking level, and Fast mode setting.",
  ];
  const resolveTask = (input: SubagentTaskInput): DomainSubagentTaskInput => {
    const model = resolveModel(input.model);
    return {
      ...input,
      model: {
        prefer: "exact",
        provider: model.provider,
        modelId: model.modelId,
        thinkingLevel: model.thinkingLevel,
      },
      fastMode: model.fastMode,
    };
  };
  const operation = <Input>(definition: {
    command: string;
    summary: string;
    schema: Schema.ConstraintDecoder<Input, never>;
    example: JsonObject;
    run(
      input: Input,
      parent: string,
      signal: AbortSignal,
      onUpdate?: (value: JsonValue) => void,
      anchorPartId?: string,
    ): Promise<JsonValue>;
  }): CakeOperationDefinition => ({
    command: definition.command,
    topic: "subagents",
    summary: definition.summary,
    guidance,
    inputSchema: definition.schema,
    examples: [{ input: definition.example }],
    result:
      "A bounded handle, activity projection, or final delegated result with attributed usage.",
    limitations: ["Subagents cannot use Cake application controls or delegate further work."],
    async execute(input, context) {
      const parent = parentSessionId();
      if (!parent) throw new Error("The parent Cake session is not ready");
      // SAFETY: CakeOperationRegistry parsed input with this definition's schema.
      return definition.run(
        input as Input,
        parent,
        context.signal,
        context.onUpdate,
        `tool-${context.toolCallId}`,
      );
    },
  });
  return [
    operation({
      command: "subagents.run",
      summary:
        "Run one isolated parent-owned subagent in the foreground, stream its activity, and return its final result.",
      schema: subagentTaskSchema,
      example: {
        task: "Inspect the authentication flow",
        model: "Sol",
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.run(resolveTask(input), parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.start",
      summary:
        "Explicitly start one isolated parent-owned subagent in the background. Cake automatically wakes the parent with its result unless the parent is already waiting on it.",
      schema: subagentTaskSchema,
      example: {
        task: "Monitor the test run",
        model: "Sol",
      },
      run: (input, parent, signal, _onUpdate, anchor) =>
        control.start(resolveTask(input), parent, signal, anchor),
    }),
    operation({
      command: "subagents.parallel",
      summary: "Run up to eight bounded subagent tasks with workspace-wide bounded concurrency.",
      schema: parallelSubagentSchema,
      example: {
        tasks: [
          {
            task: "Inspect tests",
            model: "Sol",
          },
        ],
      },
      run: (input, parent, signal, onUpdate, anchor) =>
        control.parallel({ tasks: input.tasks.map(resolveTask) }, parent, signal, onUpdate, anchor),
    }),
    operation({
      command: "subagents.prompt",
      summary: "Send a normal prompt to an idle subagent and wait for its turn.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Continue" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "prompt" }, parent, signal),
    }),
    operation({
      command: "subagents.follow-up",
      summary: "Queue a follow-up using Pi's normal queue policy.",
      schema: promptSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000", text: "Also inspect callers" },
      run: (input, parent, signal) =>
        control.prompt({ ...input, delivery: "follow-up" }, parent, signal),
    }),
    operation({
      command: "subagents.wait",
      summary:
        "Optionally wait for an explicitly backgrounded subagent. While this wait is active, its result returns through this call instead of triggering a separate parent turn.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent, signal, onUpdate) =>
        control.wait(input.handleId, parent, signal, onUpdate),
    }),
    operation({
      command: "subagents.abort",
      summary: "Cancel active work in a subagent.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.abort(input.handleId, parent),
    }),
    operation({
      command: "subagents.close",
      summary: "Release a subagent handle and its hidden runtime.",
      schema: handleSchema,
      example: { handleId: "00000000-0000-4000-8000-000000000000" },
      run: (input, parent) => control.close(input.handleId, parent),
    }),
  ];
}

function createCakeGatewayExtension(
  definitions: (pi: {
    appendEntry(type: string, data: JsonValue): void;
  }) => CakeOperationDefinition[],
): InlineExtension {
  return (pi) => {
    const registry = new CakeOperationRegistry(definitions(pi));
    pi.registerTool({
      name: "cake",
      label: "Cake",
      description: cakeToolDescription,
      // SAFETY: Pi accepts the draft-07 JSON Schema produced by Effect Schema.
      parameters: Schema.toStandardJSONSchemaV1(cakeToolEnvelopeSchema)[
        "~standard"
      ].jsonSchema.input({ target: "draft-07" }) as TSchema,
      async execute(toolCallId, params, signal, onUpdate, runtime) {
        const update = (value: JsonValue) =>
          onUpdate?.({
            content: [{ type: "text", text: formatUnknown(value, 24_000) }],
            details: value,
          });
        const result = await registry.invoke(params, {
          signal: signal ?? new AbortController().signal,
          toolCallId,
          onUpdate: update,
          runtime,
        });
        return { content: [{ type: "text", text: result.text }], details: result.details };
      },
    });
  };
}

function reviewContextExtension(
  pathForSession: (sessionId: string) => string,
  sessionId: () => string | undefined,
): InlineExtension {
  return (pi) => {
    pi.on("before_agent_start", () => {
      const id = sessionId();
      if (!id) return;
      const path = pathForSession(id);
      if (!existsSync(path)) return;
      return {
        message: {
          customType: "cake.review-context",
          display: false,
          content: `Inline code reviews and assistant-message discussions for this session are indexed at ${path}. Read or search that file when the user asks you to incorporate, summarize, or reason about those threads; otherwise leave it alone.`,
        },
      };
    });
  };
}

interface RuntimeOperationApi {
  info(): JsonValue;
  usage(): JsonValue;
  contextStatus(): JsonValue;
  compact(instructions?: string): Promise<JsonValue>;
  rename(title: string): Promise<JsonValue>;
  createSession(input: ProjectSessionCreateInput, signal: AbortSignal): Promise<JsonValue>;
  createDraftSession(
    input: { name: string; initialPrompt: string; model?: CakeModelSelection },
    signal: AbortSignal,
  ): Promise<JsonValue>;
  createChildSession(
    input: {
      title: string;
      initialPrompt: string;
      model?: CakeModelSelection;
      placement: "none" | "right" | "down";
    },
    requestId: string,
    signal: AbortSignal,
  ): Promise<JsonValue>;
  forkSession(input: {
    entryId?: string;
    prompt?: string;
    title?: string;
    resolveSource: boolean;
    placement: "none" | "right" | "down";
    destinationWorkingDirectory?: string;
  }): Promise<JsonValue>;
  invokeAppControl(command: string, input: JsonObject, signal: AbortSignal): Promise<JsonValue>;
  resolveModelSelection(selection: CakeModelSelection | undefined): ExplicitCakeModelSelection;
  setModel(model: CakeModelSelection): Promise<JsonValue>;
  setResolved(resolved: boolean): Promise<JsonValue>;
}

interface RuntimeOperationApiReference {
  current?: RuntimeOperationApi;
}

interface RuntimeIdentity {
  sessionId?: string;
}

export interface CakeRuntimeCapabilities {
  readonly resourceLoader: Awaited<ReturnType<typeof loadCakeRuntimeResourceLoader>>;
  readonly operationApi: RuntimeOperationApiReference;
  setSessionId(sessionId: string): void;
  recordAppControlResult(result: JsonValue, session: AgentSession): Promise<JsonValue>;
  reportAgentAction(
    action: "compact" | "rename" | "resolve" | "restore" | "set-model",
    detail?: string,
  ): Promise<void>;
}

export async function createCakeRuntimeCapabilities(input: {
  options: CakeRuntimeOptions;
  agentDir: string;
  settingsManager: SettingsManager;
  /** Cake-owned in-process extensions that shape provider requests. */
  requestExtensions: readonly InlineExtension[];
}): Promise<CakeRuntimeCapabilities> {
  const { options, agentDir, settingsManager, requestExtensions } = input;
  const persistArtifact =
    options.persistArtifact ??
    (async (artifact: CakeArtifactV1) =>
      Schema.decodeUnknownSync(artifactRecordSchema)({
        artifact,
        workspacePath: options.cwd,
        digest: "0".repeat(64),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
  const requestArtifact = options.requestArtifact ?? (async () => undefined);
  const operationApi: RuntimeOperationApiReference = {};
  const crossSessionReceiptSchema = Schema.Struct({
    ok: Schema.Literal(true),
    command: Schema.Literals(["sessions.send", "sessions.reply"]),
    targetTitle: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_024)),
    messageId: Schema.String.check(Schema.isUUID(4)),
    threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
    messageNumber: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    maxMessages: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
    status: Schema.Literals(["accepted", "queued", "delivered", "processing", "answered"]),
  });
  const reportAgentAction = async (
    action: "compact" | "rename" | "resolve" | "restore" | "set-model",
    detail?: string,
  ) => {
    const input: JsonObject = detail ? { action, detail } : { action };
    const signal = new AbortController().signal;
    try {
      if (options.currentSessionControl?.invokeAppControl)
        await options.currentSessionControl.invokeAppControl("agent.action", input, signal);
      else if (options.globalControl)
        await options.globalControl.invoke({ name: "agent.action", arguments: input }, signal);
    } catch {
      // The completed agent action remains authoritative when its transient receipt cannot render.
    }
  };
  const localOperations = (): CakeOperationDefinition[] => {
    const api = () => {
      if (!operationApi.current) throw new Error("The Cake session is not ready");
      return operationApi.current;
    };
    const empty = Schema.Struct({});
    const invokeAppControl =
      (command: string): CakeOperationDefinition["execute"] =>
      (input, context) => {
        // SAFETY: CakeOperationRegistry decoded input with the operation's object schema.
        return api().invokeAppControl(command, input as JsonObject, context.signal);
      };
    const operations: CakeOperationDefinition[] = [
      {
        command: "app.state",
        topic: "app",
        summary: "Inspect the invoking Cake window's current selection and session summaries.",
        inputSchema: empty,
        examples: [{}],
        result: "The current application selection, projects, and bounded session summaries.",
        execute: (_input, context) => api().invokeAppControl("app.state", {}, context.signal),
      },
      {
        command: "app.split",
        topic: "app",
        summary: "Split the calling conversation pane and open a new chat in it.",
        guidance: ["Splits are relative to the calling conversation's pane."],
        inputSchema: Schema.Struct({ direction: Schema.Literals(["right", "down"]) }),
        examples: [{ input: { direction: "right" } }],
        result: "The new pane and conversation identity.",
        execute: invokeAppControl("app.split"),
      },
      {
        command: "settings.sections",
        topic: "settings",
        summary:
          "List the Cake settings sections available to agents, including scope and writability.",
        inputSchema: empty,
        examples: [{}],
        result: "The available settings section IDs, descriptions, scopes, and writability.",
        execute: invokeAppControl("settings.sections"),
      },
      {
        command: "settings.get",
        topic: "settings",
        summary: "Read the effective settings for one Cake settings section in this window.",
        inputSchema: CakeSettingsGetInput,
        examples: [{ input: { section: "appearance" } }],
        result: "The section's effective current settings and window scope.",
        execute: invokeAppControl("settings.get"),
      },
      {
        command: "settings.update",
        topic: "settings",
        summary:
          "Patch one Cake settings section in this window and return its committed effective settings.",
        guidance: [
          "Call settings.get before updating a section. Unspecified fields remain unchanged.",
          "For hotkeys, null restores the default binding and an empty string disables the shortcut.",
        ],
        inputSchema: CakeSettingsUpdateInput,
        examples: [{ input: { section: "appearance", changes: { theme: "dark" } } }],
        result:
          "The section's committed effective settings after window-state persistence completes.",
        execute: invokeAppControl("settings.update"),
      },
      {
        command: "session.info",
        topic: "sessions",
        summary:
          "Return minimal identity, workspace, resolution, and model information for the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: empty,
        examples: [{}],
        result: "sessionId, title, workspacePath, resolved, and provider/model/reasoning only.",
        execute: async () => api().info(),
      },
      {
        command: "session.rename",
        topic: "sessions",
        summary: "Rename the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: Schema.Struct({
          title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
        }),
        examples: [{ input: { title: "Authentication refactor" } }],
        result: "The calling session ID and committed title.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().rename((input as { title: string }).title);
        },
      },
      {
        command: "session.create",
        topic: "sessions",
        summary:
          "Create, name, and start an independent Project Session in the calling session's project.",
        guidance: [
          "This singular Project Session-local operation derives the project from the caller and never accepts a workspacePath or sessionId. Cake Chat uses the separate plural sessions.create application control.",
          "Set worktreeName to create and register a new Cake-managed worktree before the Pi-backed session starts. Do not run git worktree add or try to rebind an already-started session.",
          "When worktreeName is omitted, the independent session starts in the Project root, preserving the existing behavior.",
          "When model is omitted, the new session inherits the calling session's current model, thinking level, and Fast mode setting.",
          "Use sessions.create-child only for a Session Family child that shares the caller's exact Working Directory.",
        ],
        inputSchema: projectSessionCreateInputSchema,
        examples: [
          {
            input: {
              name: "Authentication follow-up",
              initialPrompt: "Review the authentication flow and implement the next changes.",
              model: "Sol",
            },
            description: "Select a configured preset and start in the Project root.",
          },
          {
            input: {
              name: "Investigate rendering",
              initialPrompt: "Investigate the rendering issue and implement a focused fix.",
              worktreeName: "investigate-rendering",
            },
            description: "Start an independent session in a new Cake-managed worktree.",
          },
        ],
        result:
          "The started session ID, actual Working Directory, and managed-worktree record when one was requested.",
        limitations: [
          "This creates an independent Project Session, not a Session Family child.",
          "An active Project Session cannot be relocated to the newly created worktree.",
        ],
        execute: (input, context) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().createSession(input as ProjectSessionCreateInput, context.signal);
        },
      },
      {
        command: "sessions.create-child",
        topic: "sessions",
        summary: "Create and start a full child Project Session in the calling session's family.",
        guidance: [
          "Use this operation—not cake subagents—when the user asks for a child session, full child Project Session, related session, or Session Family member.",
          "Call it with input containing the required title and initialPrompt fields; the assignment field is initialPrompt, not prompt.",
          "The calling session becomes the family parent when it creates its first child.",
          "Children inherit the exact Project and Working Directory, share mutable files, and start in the background.",
          "This operation returns after the initial child turn is accepted; do not wait or poll for the child, and finish the parent turn normally.",
          "Pane placement defaults to none. Set placement to right or down only when the child should be opened beside the parent.",
          "A child cannot create another child; it must ask its parent for further delegation.",
          "When model is omitted, the child inherits the calling session's current model, thinking level, and Fast mode setting.",
        ],
        inputSchema: Schema.Struct({
          title: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          initialPrompt: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
          ),
          model: Schema.optionalKey(CakeModelSelection),
          placement: Schema.Literals(["none", "right", "down"]).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("none" as const)),
          ),
        }),
        examples: [
          {
            input: {
              title: "Storage implementation",
              initialPrompt: "Implement the storage slice and message me when it is ready.",
              model: "Sol",
              placement: "right",
            },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The stable child session identity and initial-turn launch outcome.",
        limitations: [
          "V1 families have one level and fixed Working Directory bindings.",
          "This operation does not create or select a different worktree.",
        ],
        execute: (input, context) =>
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          api().createChildSession(
            input as {
              title: string;
              initialPrompt: string;
              model?: CakeModelSelection;
              placement: "none" | "right" | "down";
            },
            context.toolCallId,
            context.signal,
          ),
      },
      {
        command: "session.fork",
        topic: "sessions",
        summary:
          "Fork the calling session at a specific transcript entry or, when omitted, at the latest settled entry.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
          "Omit entryId to fork the whole active conversation through its latest settled message.",
          "When called during an active response, the fork is created after that response settles so an omitted entryId includes the completed response.",
          "When prompt is provided, the fork starts with that message. The source is resolved only after the fork and prompt succeed.",
        ],
        inputSchema: Schema.Struct({
          entryId: Schema.optionalKey(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          ),
          prompt: Schema.optionalKey(
            Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          ),
          title: Schema.optionalKey(
            Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          ),
          resolveSource: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
          placement: Schema.Literals(["none", "right", "down"]).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("none" as const)),
          ),
          destinationWorkingDirectory: Schema.optionalKey(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32_768)),
          ),
        }),
        examples: [
          {
            input: {
              prompt: "Continue by implementing the agreed approach.",
              title: "Implement fork tool",
              resolveSource: true,
              placement: "right",
            },
          },
        ],
        result:
          "A fork-on-settle receipt. After the turn settles, Cake creates and optionally starts the fork, then resolves the source when requested.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().forkSession(
            input as {
              entryId?: string;
              prompt?: string;
              title?: string;
              resolveSource: boolean;
              placement: "none" | "right" | "down";
              destinationWorkingDirectory?: string;
            },
          );
        },
      },
      {
        command: "session.create-draft",
        topic: "sessions",
        summary:
          "Create a saved draft in the calling Project Session's project without starting a Pi session.",
        guidance: [
          "This operation derives the project from the calling session and never accepts a workspacePath or sessionId.",
          "When model is omitted, the draft snapshots the calling session's current model, thinking level, and Fast mode setting.",
        ],
        inputSchema: Schema.Struct({
          name: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
          initialPrompt: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
          ),
          model: Schema.optionalKey(CakeModelSelection),
        }),
        examples: [
          {
            input: {
              name: "Authentication follow-up",
              initialPrompt: "Review the authentication flow and propose the next changes.",
              model: "Sol",
            },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The saved draft session ID and confirmation that renderer persistence completed.",
        execute: (input, context) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().createDraftSession(
            input as { name: string; initialPrompt: string; model?: CakeModelSelection },
            context.signal,
          );
        },
      },
      {
        command: "sessions.list",
        topic: "sessions",
        summary: "List Project Sessions across all registered Cake projects.",
        inputSchema: empty,
        examples: [{}],
        result:
          "Project Session identities, projects, paths, titles, activity, and resolution state.",
        execute: (_input, context) => api().invokeAppControl("sessions.list", {}, context.signal),
      },
      {
        command: "sessions.send",
        topic: "sessions",
        summary: "Send a message to an explicitly targeted Project Session in any Cake project.",
        guidance: [
          "Set delivery to steer to interrupt and redirect a running target. Omit delivery for normal behavior: start an idle target or queue behind an active target.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
          maxMessages: Schema.optionalKey(
            Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1_000)),
          ),
        }),
        examples: [{ input: { sessionId: "target-session-id", text: "Review the API changes." } }],
        result:
          "A visible correlated receipt with target label, thread and message IDs, count, delivery state, and accepted delivery mode.",
        execute: invokeAppControl("sessions.send"),
      },
      {
        command: "sessions.abort",
        topic: "sessions",
        summary: "Stop the active turn in an explicitly targeted Project Session.",
        guidance: [
          "Use this to stop a running child or other Project Session without resolving or deleting it; the session remains available for later messages.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        }),
        examples: [{ input: { sessionId: "target-session-id" } }],
        result: "A confirmed stopping status, or an error when the target is not running.",
        execute: invokeAppControl("sessions.abort"),
      },
      {
        command: "sessions.rename",
        topic: "sessions",
        summary: "Rename an explicitly targeted Project Session in any Cake project.",
        guidance: [
          "Use session.rename for the calling session. Use sessions.rename with a sessionId from sessions.list or a child creation result to rename any other Project Session, whether idle or running.",
        ],
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          title: Schema.Trim.pipe(
            Schema.check(Schema.isMinLength(1), Schema.isMaxLength(SESSION_TITLE_MAX_LENGTH)),
          ),
        }),
        examples: [{ input: { sessionId: "target-session-id", title: "Storage implementation" } }],
        result: "The target session identity and its committed title.",
        execute: invokeAppControl("sessions.rename"),
      },
      {
        command: "sessions.reply",
        topic: "sessions",
        summary:
          "Reply to the originating session in the current open exchange without carrying its session ID.",
        inputSchema: Schema.Struct({
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          delivery: Schema.optionalKey(Schema.Literals(["prompt", "queue", "steer"])),
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: { text: "I agree; here is one caveat." } }],
        result: "A correlated delivery receipt for the safely bound reply target.",
        execute: invokeAppControl("sessions.reply"),
      },
      {
        command: "sessions.thread",
        topic: "sessions",
        summary: "Inspect participants, message count, limit, closure, and delivery states.",
        inputSchema: Schema.Struct({
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: {} }],
        result: "The current Cake coordination thread projection.",
        execute: invokeAppControl("sessions.thread"),
      },
      {
        command: "sessions.close-thread",
        topic: "sessions",
        summary:
          "Close the current exchange so queued or late arrivals cannot cause an automatic reply.",
        inputSchema: Schema.Struct({
          threadId: Schema.optionalKey(Schema.String.check(Schema.isUUID(4))),
        }),
        examples: [{ input: {} }],
        result: "A closed thread receipt and final message count.",
        execute: invokeAppControl("sessions.close-thread"),
      },
      {
        command: "sessions.compact",
        topic: "sessions",
        summary: "Compact an explicitly targeted Project Session.",
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
        }),
        examples: [{ input: { sessionId: "target-session-id" } }],
        result: "A completed compaction status.",
        execute: invokeAppControl("sessions.compact"),
      },
      {
        command: "sessions.schedule",
        topic: "sessions",
        summary:
          "Schedule a message to an explicitly targeted Project Session at an ISO timestamp.",
        inputSchema: Schema.Struct({
          sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          text: Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100_000))),
          sendAt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
        }),
        examples: [
          {
            input: {
              sessionId: "target-session-id",
              text: "Check the build result.",
              sendAt: "2030-01-01T12:00:00.000Z",
            },
          },
        ],
        result: "The durable scheduled message and its ID.",
        execute: invokeAppControl("sessions.schedule"),
      },
      {
        command: "sessions.scheduled",
        topic: "sessions",
        summary: "List durable scheduled messages, optionally for one Project Session.",
        inputSchema: Schema.Struct({
          sessionId: Schema.optionalKey(
            Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          ),
        }),
        examples: [{}],
        result: "Scheduled message IDs, destinations, text, and send times.",
        execute: invokeAppControl("sessions.scheduled"),
      },
      {
        command: "sessions.cancel-scheduled",
        topic: "sessions",
        summary: "Cancel one scheduled message by ID.",
        inputSchema: Schema.Struct({
          id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
        }),
        examples: [{ input: { id: "scheduled-message-id" } }],
        result: "A cancellation status.",
        execute: invokeAppControl("sessions.cancel-scheduled"),
      },
      {
        command: "session.resolve",
        topic: "sessions",
        summary: "Idempotently resolve or restore the calling session.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
          "Resolving during an active response is scheduled for the moment that response settles.",
        ],
        inputSchema: Schema.Struct({ resolved: Schema.Boolean }),
        examples: [{ input: { resolved: true } }],
        result:
          "The calling session ID and either the committed resolved value or a resolveOnSettle marker.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().setResolved((input as { resolved: boolean }).resolved);
        },
      },
      {
        command: "session.usage",
        topic: "sessions",
        summary:
          "Return normalized provider-reported token usage and cost for the calling session.",
        guidance: ["Usage is advisory and is not a hard spending-limit mechanism."],
        inputSchema: empty,
        examples: [{}],
        result: "Normalized token counts, reported cost in USD, and honest pricing coverage.",
        execute: async () => api().usage(),
      },
      {
        command: "session.set-model",
        topic: "sessions",
        summary:
          "Set the calling session's model from a configured preset or explicit configuration.",
        guidance: [
          "Singular session.* operations always target the calling session and never accept a sessionId.",
        ],
        inputSchema: Schema.Struct({ model: CakeModelSelection }),
        examples: [
          {
            input: { model: "Sol" },
            description: "Select a configured preset by name.",
          },
        ],
        result: "The committed provider, model ID, thinking level, and Fast mode setting.",
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().setModel((input as { model: CakeModelSelection }).model);
        },
      },
      {
        command: "context.status",
        topic: "context",
        summary: "Inspect estimated current context use through Pi's public usage facilities.",
        inputSchema: empty,
        examples: [{}],
        result: "tokens, limit, remaining, utilization, and measurement only.",
        execute: async () => api().contextStatus(),
      },
      {
        command: "context.compact",
        topic: "context",
        summary: "Invoke Pi's normal compaction mechanism for the calling session.",
        inputSchema: Schema.Struct({
          instructions: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(262_144))),
        }),
        examples: [
          {
            input: { instructions: "Preserve implementation decisions and pending verification." },
          },
        ],
        result: "A completed compaction status.",
        limitations: ["Cake does not create a separate summary or transcript representation."],
        execute: (input) => {
          // SAFETY: CakeOperationRegistry parsed input with this operation's schema.
          return api().compact((input as { instructions?: string }).instructions);
        },
      },
      {
        command: "notifications.send",
        topic: "notifications",
        summary: "Send a bounded native system notification through the operating system.",
        inputSchema: Schema.Struct({
          title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
          body: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000)),
          level: Schema.Literals(["info", "success", "warning", "error"]).pipe(
            Schema.withDecodingDefaultKey(Effect.succeed("info" as const)),
          ),
        }),
        examples: [
          {
            input: {
              title: "Authentication refactor complete",
              body: "The implementation and focused tests are ready for review.",
              level: "success",
            },
          },
        ],
        result: "A queued status after Cake accepts the notification for debounced delivery.",
        limitations: [
          "Notifications are debounced per calling session, so only the latest message in a burst is delivered.",
          "Notifications do not impersonate user input or enter another session transcript.",
        ],
        execute: invokeAppControl("notifications.send"),
      },
    ];
    return operations.filter(
      (operation) =>
        (operation.command !== "session.resolve" ||
          (options.currentSessionControl !== undefined &&
            options.currentSessionControl.canResolve?.() !== false)) &&
        (![
          "app.state",
          "app.split",
          "settings.sections",
          "settings.get",
          "settings.update",
          "notifications.send",
        ].includes(operation.command) ||
          options.currentSessionControl?.invokeAppControl !== undefined) &&
        (operation.command !== "session.create" ||
          options.currentSessionControl?.createSession !== undefined) &&
        (operation.command !== "session.create-draft" ||
          options.currentSessionControl?.createDraftSession !== undefined) &&
        (operation.command !== "session.fork" ||
          options.currentSessionControl?.forkSession !== undefined) &&
        (operation.command !== "sessions.create-child" ||
          options.currentSessionControl?.createChildSession !== undefined) &&
        (!operation.command.startsWith("sessions.") ||
          operation.command === "sessions.create-child" ||
          options.currentSessionControl?.invokeAppControl !== undefined),
    );
  };
  const runtimeIdentity: RuntimeIdentity = {};
  const readOnlyAuxiliary =
    Boolean(options.auxiliary) &&
    !(options.tools ?? []).some((tool) => tool === "bash" || tool === "edit" || tool === "write");
  const filterRuntimeOperations = (definitions: CakeOperationDefinition[]) =>
    readOnlyAuxiliary
      ? definitions.filter((definition) =>
          ["session.info", "session.usage", "context.status"].includes(definition.command),
        )
      : definitions;
  const resolveApiModel = (selection: CakeModelSelection | undefined) => {
    if (!operationApi.current) throw new Error("The Cake session is not ready");
    return operationApi.current.resolveModelSelection(selection);
  };
  const globalControl = options.globalControl;
  const detectedWorktree = globalControl ? undefined : await detectGitWorktree(options.cwd);
  const detectedWorktreePrompt = detectedWorktree
    ? worktreeSystemPrompt(detectedWorktree)
    : undefined;
  const resourceLoader = await loadCakeRuntimeResourceLoader({
    trusted: options.trusted,
    makeResourceLoader: () =>
      new DefaultResourceLoader(
        globalControl
          ? {
              cwd: options.cwd,
              agentDir,
              settingsManager,
              extensionFactories: [
                ...requestExtensions,
                createCakeGatewayExtension((pi) =>
                  filterRuntimeOperations([
                    ...localOperations(),
                    ...createGlobalControlOperations(globalControl, resolveApiModel),
                    ...(options.modelPresets
                      ? createCakeModelOperations(options.modelPresets)
                      : []),
                    ...createCakeArtifactOperations(pi, {
                      persistArtifact,
                      requestArtifact,
                      generateInlineWidget: options.generateInlineWidget,
                    }),
                    ...(options.vscodeControl
                      ? createCakeVscodeOperations(options.vscodeControl)
                      : []),
                    ...(options.worktreeLandingControl
                      ? createCakeWorktreeOperations(options.worktreeLandingControl)
                      : []),
                    ...(options.agentControl
                      ? createAgentControlOperations(
                          options.agentControl,
                          () => runtimeIdentity.sessionId,
                          resolveApiModel,
                        )
                      : []),
                  ]),
                ),
                createCakeArtifactExtension({ persistArtifact, requestArtifact }),
              ],
              appendSystemPromptOverride: (base) => [...base, cakeChatSystemPrompt],
            }
          : {
              cwd: options.cwd,
              agentDir,
              settingsManager,
              systemPrompt: options.isolatedSystemPrompt,
              appendSystemPromptOverride: (base) =>
                options.isolatedSystemPrompt
                  ? []
                  : [
                      ...base,
                      cakeProjectSystemPrompt,
                      ...(options.additionalSystemPrompt ? [options.additionalSystemPrompt] : []),
                      ...(detectedWorktreePrompt ? [detectedWorktreePrompt] : []),
                    ],
              additionalSkillPaths: [],
              additionalPromptTemplatePaths: [],
              additionalExtensionPaths: [],
              noExtensions: options.auxiliary,
              noSkills: options.auxiliary,
              noPromptTemplates: options.auxiliary,
              noThemes: options.auxiliary,
              noContextFiles: options.isolatedSystemPrompt !== undefined,
              extensionFactories: [
                ...requestExtensions,
                createCakeGatewayExtension((pi) =>
                  filterRuntimeOperations([
                    ...localOperations(),
                    ...(options.modelPresets
                      ? createCakeModelOperations(options.modelPresets)
                      : []),
                    ...createCakeArtifactOperations(pi, {
                      persistArtifact,
                      requestArtifact,
                      generateInlineWidget: options.generateInlineWidget,
                    }),
                    ...(options.vscodeControl
                      ? createCakeVscodeOperations(options.vscodeControl)
                      : []),
                    ...(options.worktreeLandingControl
                      ? createCakeWorktreeOperations(options.worktreeLandingControl)
                      : []),
                    ...(options.agentControl
                      ? createAgentControlOperations(
                          options.agentControl,
                          () => runtimeIdentity.sessionId,
                          resolveApiModel,
                        )
                      : []),
                  ]),
                ),
                createCakeArtifactExtension({ persistArtifact, requestArtifact }),
                ...(options.reviewContextPath
                  ? [
                      reviewContextExtension(
                        options.reviewContextPath,
                        () => runtimeIdentity.sessionId,
                      ),
                    ]
                  : []),
              ],
            },
      ),
  });
  return {
    resourceLoader,
    operationApi,
    setSessionId(sessionId) {
      runtimeIdentity.sessionId = sessionId;
    },
    async recordAppControlResult(result, session) {
      const receipt = Schema.decodeUnknownOption(crossSessionReceiptSchema)(result);
      if (Option.isSome(receipt)) {
        const count = receipt.value.messageNumber
          ? ` ${receipt.value.messageNumber}${receipt.value.maxMessages ? `/${receipt.value.maxMessages}` : ""}`
          : "";
        await session.sendCustomMessage(
          {
            customType: "Cross-session delivery",
            content: `${receipt.value.status === "queued" ? "Queued" : "Accepted"} message${count} for “${receipt.value.targetTitle}”`,
            display: true,
            details: result,
          },
          { triggerTurn: false },
        );
      }
      return result;
    },
    reportAgentAction,
  };
}
