import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS } from "../../contracts/cake-chats/cake-chat-preferences";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  AgentDoc,
  createRegistry,
  defineExtension,
  defineTool,
  InboxDoc,
  LiveDoc,
  UsageDoc,
  type HarnessSettings,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type, type TSchema } from "@earendil-works/pi-durable-ai";
import { estimateContextTokens } from "@earendil-works/pi-durable-ai/utils/estimate";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { copyJson } from "@earendil-works/chord";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Attachment,
  ChatConfiguration,
  ConversationSnapshot,
  PiSettingUpdate,
  ThinkingLevel,
  UiPart,
} from "../../contracts/conversations/session-contract";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelLaunch,
} from "../../contracts/model-presets/cake-model-selection";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
} from "../pi/runtime/cake-operation-registry";
import { applyPiSetting, projectPiSettings } from "../pi/runtime/settings-translation";
import { projectSessionEntries } from "../pi/runtime/session-projection";
import { projectModelCatalog } from "../pi/live/PiModelsLive";
import { supportsFastMode } from "../pi/fast-mode";
import { TurnCanceledError } from "../pi/runtime/RuntimeTurnCompletion";
import {
  subagentCompletionMessage,
  type CakeSessionRuntime,
  type CakeSessionRuntimeOptions,
} from "../pi/runtime/cake-session-runtime";
import { durableModels } from "./durable-models";
import type { RequestInspection } from "./request-inspection";
import { openDurableChatEngine } from "./durable-chat-engine";
import { createDurableSideChats, type DurableSideChats } from "./durable-side-chats";
import { readDurableActiveTools, readDurableOriginalPage } from "./durable-chat-history";
import {
  listDurableMessageReferences,
  readDurableMessageReference,
} from "./durable-message-references";
import { toJsonValue } from "../../utils/to-json-value";
import {
  createDurableConversationRecallTools,
  durableConversationRecallInstructions,
} from "./durable-conversation-recall";

import { durableChatDatabase } from "./durable-chat-location";
import { createDurableChatCatalog } from "./durable-chat-catalog";
import { coordinatorSystemPrompt } from "./coordinator-system-prompt";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { PresetContextDoc, presetContextSection, PresetState } from "./durable-preset-context";
import { cakeAgentDocumentationDirectory } from "../pi/runtime/cake-agent-documentation";
import { createDurableChatCommands } from "./durable-chat-commands";
import { abortDurableActiveTurn, createDurableConversationQueue } from "./durable-chat-queue";
import { loadAgentDirectoryExtensions } from "../pi/runtime/extension-providers";
import {
  cakeChatExecutionEnv,
  cakeChatScratchDirectory,
  createCakeChatBashTool,
  createCakeChatReadTool,
} from "./cake-chat-local-tools";
import { CakeChatMcp, createCakeChatMcpTool, loadCakeChatMcpServers } from "./cake-chat-mcp";
import { isCakeChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { SubagentResult, SubagentReportOrigin } from "../../contracts/subagents/subagent-data";
import { Option } from "effect";
import type { InternalInput } from "../../contracts/conversations/internal-input";
import { durableInputText, durableQueuedPart } from "./durable-input-presentation";
import {
  setDurableUserMessageMarkdown,
  UserMessagePresentationDoc,
} from "./durable-message-presentation";
import { durableInputResponse, previousDurableResponseMode } from "./durable-response-mode";
import type { ConversationResponseMode } from "../../contracts/conversations/response-mode-reminders";
const unsupported = async () => {
  throw new Error(
    "The permanent Cake Chat cannot be edited, renamed or navigated as a Project Session",
  );
};

/** The coordinator runtime and the side-chat forks that share its Durable database. */
export type DurableCakeChatRuntime = CakeSessionRuntime & {
  readonly sideChats: DurableSideChats;
  readonly catalog: ReturnType<typeof createDurableChatCatalog>;
};

/** The shared Cake conversation contract, backed solely by Pi Durable for the coordinator. */
export async function createDurableCakeChatRuntime(
  options: CakeSessionRuntimeOptions,
  inspection?: RequestInspection,
): Promise<DurableCakeChatRuntime> {
  if (
    !options.coordinator ||
    !options.cakeChatMemory ||
    !options.sessionId ||
    !isCakeChatSessionId(options.sessionId)
  )
    throw new Error("Durable Cake Chat requires the coordinator capability profile");
  const preferences = options.cakeChatMemory;
  const sessionId = options.sessionId;
  const sessionFile = durableChatDatabase(options.sessionDir);
  const settings = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.trusted,
  });
  const commands = await createDurableChatCommands(options.cwd, options.agentDir, settings);
  const cakeDocsDirectory = await cakeAgentDocumentationDirectory(options.agentDir);
  const instructions = () =>
    [
      coordinatorSystemPrompt(preferences.preferences().instructions, cakeDocsDirectory),
      durableConversationRecallInstructions(sessionId),
      options.additionalSystemPrompt,
      options.cakeChatSystemPrompt?.(),
      commands.instructions(),
    ]
      .filter(Boolean)
      .join("\n\n");
  const catalogRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
    modelsStorePath: join(options.agentDir, "models-cache.json"),
  });
  let fastMode = options.fastMode?.get() ?? false;
  const agentExtensions = await loadAgentDirectoryExtensions(options.agentDir, catalogRuntime);
  const scratchDirectory = cakeChatScratchDirectory(options.sessionDir);
  await mkdir(scratchDirectory, { recursive: true });
  const mcpServers = await loadCakeChatMcpServers({
    agentDirectory: options.agentDir,
    registered: agentExtensions.mcpServers,
  });
  const mcp = new CakeChatMcp(mcpServers.servers, { cwd: scratchDirectory });
  const models = durableModels(
    catalogRuntime,
    () => fastMode,
    inspection,
    options.sessionReferences,
    sessionId,
  );
  const available = await catalogRuntime.getAvailable();
  const presets = options.coordinator.modelPresets?.();
  const preset = presets?.presets.find((entry) => entry.id === presets.defaultPresetId);
  const defaultModel = preset
    ? catalogRuntime.getModel(preset.provider, preset.modelId)
    : (catalogRuntime.getModel(
        settings.getDefaultProvider() ?? "",
        settings.getDefaultModel() ?? "",
      ) ?? available[0]);
  if (!defaultModel)
    throw new Error("Configure an authenticated chat model in Settings before opening Cake Chat");
  let thinkingLevel: ThinkingLevel =
    preset?.thinkingLevel ?? settings.getDefaultThinkingLevel() ?? "off";
  let selected = defaultModel;
  let activePreset: ChatConfiguration["preset"];
  let unavailableModel: { provider: string; modelId: string } | undefined;
  const projectModels = async () =>
    (await projectModelCatalog(catalogRuntime, getSupportedThinkingLevels)).map(
      ({ supportedThinkingLevels, ...model }) => ({
        ...model,
        availableThinkingLevels: supportedThinkingLevels,
      }),
    );
  let modelOptions = await projectModels();
  let disposed = false;
  let streaming = false;
  let activeTurnIds: string[] = [];
  const diagnostics: string[] = [...agentExtensions.errors, ...mcpServers.errors];
  const currentConfiguration = (): ExplicitCakeModelSelection => ({
    provider: selected.provider,
    modelId: selected.id,
    thinkingLevel,
    fastMode,
    ...(activePreset ? { preset: activePreset } : null),
  });
  const resolveModel = (
    selection: CakeModelSelection | undefined,
    launch?: CakeModelLaunch,
  ): ExplicitCakeModelSelection => {
    const caller = currentConfiguration();
    if (options.resolveModelSelection)
      return options.resolveModelSelection(selection, caller, launch);
    if (typeof selection === "string")
      throw new Error("Model preset resolution is unavailable in this runtime");
    return { ...(selection ?? caller) };
  };
  const operations = new CakeOperationRegistry(
    options.coordinator.operations({
      sessionId,
      resolveModel,
      info: async () => ({ sessionId, kind: "cake-chat", sessionFile, streaming }),
      usage: async () =>
        Schema.decodeUnknownSync(Schema.Json)((await runtime.snapshot()).usage ?? {}),
      contextStatus: async () => {
        const context = await engine.root.context(BACKGROUND_CONTEXT);
        const { tokens } = estimateContextTokens(context.messages);
        return {
          tokens,
          contextWindow: selected.contextWindow,
          percent: (tokens / selected.contextWindow) * 100,
        };
      },
      compact: async () => {
        await runtime.compact();
        return { compacted: true };
      },
      setModel: async (model) => {
        await runtime.applyConfiguration(model);
      },
    }),
    options.sessionReferences?.project,
  );
  const registry = createRegistry();
  const parameters = Schema.toStandardJSONSchemaV1(cakeToolEnvelopeSchema)[
    "~standard"
  ].jsonSchema.input({ target: "draft-07" });
  const cake = defineTool({
    name: "cake",
    description: cakeToolDescription,
    // SAFETY: the standard JSON schema is the schema the operation registry validates.
    parameters: parameters as TSchema,
    // Mutations (notably session spawning) must never be blindly replayed after a crash.
    replay: "unsafe",
    executionMode: "sequential",
    async execute(input, api, context) {
      // Side-chat forks inherit this tool so their request stays cache-identical to
      // Cake Chat's, but acting as Cake Chat from a side chat would write back into it.
      if (api.conversationId !== engine.root.id)
        throw new Error(
          "Cake controls are unavailable in side chats. Return to Cake Chat to act on Cake.",
        );
      const result = await operations.invoke(input, {
        signal: context.abortSignal ?? new AbortController().signal,
        toolCallId: api.callId,
        runtime: { sessionId, model: { provider: selected.provider, id: selected.id } },
        onUpdate: (value) => {
          void api.details(copyJson(value), context).catch(() => undefined);
        },
      });
      return { output: result.content, details: copyJson(result.details) };
    },
  });
  const zoom = defineTool({
    name: "zoom",
    description:
      "Primary entry point for dialogue represented in compressed memory: open the relevant id+n range into its two children; n=1 returns original dialogue and retained inline images, not full tool records. Use conversation_search/conversation_read for unlocated material or omitted evidence; read section=record for recorded tool details.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    async execute(input, _api, context) {
      const result = await engine.memory.zoom(
        input.id,
        input.n,
        context.abortSignal ?? new AbortController().signal,
      );
      return {
        output: [
          { type: "text", text: result.text },
          ...result.messages.flatMap((message) =>
            typeof message.content === "string"
              ? []
              : message.content.filter((block) => block.type === "image"),
          ),
        ],
      };
    },
  });
  const date = defineTool({
    name: "date",
    description: "Get the backend-recorded date and time of a memory message by id.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
    replay: "safe",
    async execute(input, _api, context) {
      const original = await engine.memory.zoom(
        input.id,
        1,
        context.abortSignal ?? new AbortController().signal,
      );
      const timestamp = original.messages.find((message) => "timestamp" in message)?.timestamp;
      if (timestamp === undefined) throw new Error("Original has no timestamp");
      return { output: [{ type: "text", text: new Date(timestamp).toISOString() }] };
    },
  });
  await mkdir(dirname(sessionFile), { recursive: true });
  const storage = await openNodeSqliteStorage(sessionFile);
  // Direct quick-check tools. No edit/write: project changes belong to Project Sessions.
  const tools = [
    cake,
    zoom,
    date,
    ...createDurableConversationRecallTools({ sessionId, storage }),
    createCakeChatReadTool(),
    createCakeChatBashTool(),
    createCakeChatMcpTool(mcp),
  ];
  registry.install(
    defineExtension({ name: "cake-coordinator", tools, sections: [presetContextSection] }),
  );
  let publishing: Promise<void> | undefined;
  let publishAgain = false;
  const publish = () => {
    if (disposed) return;
    publishAgain = true;
    if (publishing) return;
    publishing = (async () => {
      while (publishAgain && !disposed) {
        publishAgain = false;
        const snapshot = await runtime.snapshot();
        if (!disposed) options.onEvent({ type: "snapshot", snapshot });
      }
    })()
      .catch((error: unknown) => {
        diagnostics.splice(
          0,
          diagnostics.length,
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        publishing = undefined;
      });
  };
  const sdkSettings: HarnessSettings = {
    contextRetentionMs: 0,
    get steeringMode() {
      return settings.getSteeringMode();
    },
    get followUpMode() {
      return settings.getFollowUpMode();
    },
    get stream() {
      return { transport: settings.getTransport() };
    },
    get retry() {
      return settings.getRetrySettings();
    },
    get compaction() {
      // The engine disables SDK automatic compaction and owns both limit resets
      // and bounded overflow recovery without background prefix rewriting.
      return settings.getCompactionSettings(selected);
    },
  };
  const newCoordinator = !(await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT));
  const engine = await openDurableChatEngine({
    storage,
    models,
    registry,
    settings: sdkSettings,
    env: cakeChatExecutionEnv(scratchDirectory),
    agent: {
      model: { provider: selected.provider, modelId: selected.id },
      thinkingLevel,
      tools,
      instructions: instructions(),
    },
    contextLimitTokens: () =>
      preferences.preferences().contextLimitTokens ?? DEFAULT_CAKE_CHAT_CONTEXT_LIMIT_TOKENS,
    onInputConsumed: options.onCakeChatInputConsumed,
    memory: {
      budget: () => preferences.preferences().memoryViewBytes,
      summarize: (input) =>
        preferences.summarize({
          ...input,
          caller: currentConfiguration(),
          observeRequest: inspection
            ? (model, settings) =>
                inspection.begin(sessionId, model, settings, settings.fastMode, "memory-summary")
            : undefined,
        }),
    },
    onChanged: () => {
      publish();
    },
    onReport: (error) => {
      diagnostics.splice(
        0,
        diagnostics.length,
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  const {
    inbox,
    requestId,
    operations: queueOperations,
  } = createDurableConversationQueue({
    harness: engine.harness,
    conversation: engine.root,
    storage,
    kind: "root",
    executingTurnIds: () => activeTurnIds,
  });
  const history = (cursor?: string) =>
    engine.root.commit(
      async (tx) =>
        readDurableOriginalPage(
          {
            entries: (query, limit, next) =>
              tx.scanEntries({ ...query, conversationId: engine.root.id }, limit, next),
          },
          cursor,
          await readDurableActiveTools(tx, engine.root.id),
          (await tx.doc(UserMessagePresentationDoc, engine.root.id)).overrides,
        ),
      BACKGROUND_CONTEXT,
    );
  const configureAgent = async () => {
    await engine.root.commit(async (tx) => {
      const state = await tx.doc(PresetContextDoc, engine.root.id);
      if (activePreset) state.preset = activePreset;
      else delete state.preset;
    }, BACKGROUND_CONTEXT);
    await engine.root.configure(
      {
        model: unavailableModel ?? { provider: selected.provider, modelId: selected.id },
        thinkingLevel,
        // Saved coordinators predate some tools; the offered set is code-owned, not persisted policy.
        tools,
        instructions: instructions(),
      },
      BACKGROUND_CONTEXT,
    );
  };
  const admit = async (
    text: string,
    delivery: "prompt" | "steer" | "follow-up",
    attachments: Attachment[],
    id?: string,
    markdown = false,
    subagentReport?: SubagentReportOrigin,
    responseMode?: ConversationResponseMode,
    internal?: InternalInput,
  ) => {
    // Defense in depth: no caller may submit payload-bearing attachments to the coordinator.
    // Annotations quote Cake Chat's own transcript and stay inline.
    if (
      attachments.some(
        (attachment) => attachment.kind !== "input" && attachment.kind !== "annotation",
      )
    )
      throw new Error("Cake Chat accepts attachment references only");
    // Skill expansion is text-only and never changes the coordinator's tool profile.
    // No `!` shell escape is parsed, so input is never a user shell command.
    text = await commands.expand(text);
    await configureAgent();
    const busy =
      delivery === "steer" &&
      (await engine.harness.snapshot(LiveDoc, engine.root.id, BACKGROUND_CONTEXT))?.run !==
        undefined;
    // Voice guidance follows the same transition rule as Project Sessions, read from
    // the durable inbox and history rather than in-memory state.
    const response = durableInputResponse(
      await previousDurableResponseMode(engine.root, await inbox(), delivery),
      responseMode,
    );
    const content = [
      {
        type: "text" as const,
        text: durableInputText(
          text,
          attachments,
          markdown,
          busy,
          subagentReport,
          response,
          internal,
        ),
      },
      // Reference attachments have no image parts.
    ];
    return engine.root.submit(
      {
        type: "input",
        content,
        requestId: id ?? randomUUID(),
        whenBusy: delivery === "steer" ? "steer" : "followUp",
      },
      BACKGROUND_CONTEXT,
    );
  };
  const sideChats = createDurableSideChats({
    parentSessionId: sessionId,
    harness: engine.harness,
    root: engine.root,
    storage,
    sessionFile,
    catalog: catalogRuntime,
    settings,
    models: () => modelOptions,
    fastMode: () => fastMode,
  });
  const runtime: DurableCakeChatRuntime = {
    catalog: createDurableChatCatalog(options.sessionDir, engine.harness, storage, sessionId),
    sessionId,
    sessionFile,
    sideChats,
    get streaming() {
      return streaming;
    },
    executingTurnIds: () => activeTurnIds,
    recordReviewRun() {
      throw new Error("Project review runs do not belong to permanent chats");
    },
    history,
    async queueCommand() {
      throw new Error("Queued Pi slash commands are available only in Project Sessions");
    },
    async inspectSession(query) {
      if (query.kind === "context-outline") {
        return toJsonValue(await engine.contextInspection(options.cwd));
      }
      if (query.kind === "memory-detail") {
        if (query.memoryId === undefined || query.memoryCount === undefined)
          throw new Error("A memory range is required");
        return toJsonValue(
          await engine.memory.inspect(query.memoryId, query.memoryCount, engine.signal),
        );
      }
      if (query.kind === "messages-list")
        return toJsonValue(await listDurableMessageReferences(engine.root, sessionId, query));
      if (query.kind === "messages-read")
        return toJsonValue(await readDurableMessageReference(engine.root, sessionId, query));
      throw new Error(
        "Pi transcript-tree queries are available only in Project Sessions; use coordinator history or zoom for Cake Chat originals",
      );
    },
    async snapshot() {
      // One Session-line read prevents a completed original and its stale live
      // preview from appearing together, or model/inbox facts from different commits.
      const snapshot = await engine.root.commit(async (tx) => {
        const page = await readDurableOriginalPage(
          {
            entries: (query, limit, cursor) =>
              tx.scanEntries({ ...query, conversationId: engine.root.id }, limit, cursor),
          },
          undefined,
          await readDurableActiveTools(tx, engine.root.id),
          (await tx.doc(UserMessagePresentationDoc, engine.root.id)).overrides,
        );
        const live = await tx.doc(LiveDoc, engine.root.id);
        const agent = await tx.doc(AgentDoc, engine.root.id);
        const usage = await tx.doc(UsageDoc, engine.root.id);
        const items = (await tx.doc(InboxDoc, engine.root.id)).items;
        streaming = live?.run !== undefined;
        activeTurnIds = await Promise.all(
          (live?.run?.inputs ?? []).map(
            async (id) =>
              (await storage.submission(id, BACKGROUND_CONTEXT))?.requestId ?? String(id),
          ),
        );
        if (agent.model) {
          const restored = catalogRuntime.getModel(agent.model.provider, agent.model.modelId);
          unavailableModel = restored
            ? undefined
            : { provider: agent.model.provider, modelId: agent.model.modelId };
          selected = restored ?? selected;
        }
        thinkingLevel = agent.thinkingLevel ?? thinkingLevel;
        const parts: UiPart[] = [...page.parts];
        if (live?.generation?.message) {
          const message = live.generation.message;
          const partial = projectSessionEntries(
            [
              {
                type: "message",
                id: `live-${live.run?.taskId}`,
                parentId: null,
                timestamp: new Date(message.timestamp).toISOString(),
                message,
              },
            ],
            undefined,
            { live: true },
          );
          parts.push(
            ...partial.map((part) =>
              part.kind === "text" ? { ...part, status: "streaming" as const } : part,
            ),
          );
        }
        for (const item of items)
          if (item.mode !== "write") {
            const id = await requestId(item);
            parts.push(durableQueuedPart(item, id));
          }
        const sums = Object.values(usage?.models ?? {}).concat(Object.values(usage?.tools ?? {}));
        const tokens = sums.reduce(
          (sum, use) => ({
            input: sum.input + use.input,
            output: sum.output + use.output,
            cacheRead: sum.cacheRead + use.cacheRead,
            cacheWrite: sum.cacheWrite + use.cacheWrite,
            total: sum.total + use.totalTokens,
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        );
        return {
          workspacePath: options.cwd,
          sessionId,
          sessionFile,
          sessionListed: true,
          parts,
          historyCursor: page.cursor,
          model: {
            provider: unavailableModel?.provider ?? selected.provider,
            id: unavailableModel?.modelId ?? selected.id,
            name: unavailableModel?.modelId ?? selected.name,
          },
          models: modelOptions,
          thinkingLevel,
          availableThinkingLevels: getSupportedThinkingLevels(selected),
          streaming,
          fastMode,
          preset: activePreset,
          fastModeAvailable: supportsFastMode(selected),
          piSettings: projectPiSettings(settings),
          diagnostics: [...diagnostics],
          commands: commands.catalog(),
          usage: {
            tokens,
            cost: sums.reduce((sum, use) => sum + use.cost.total, 0),
          },
          compatibility: commands.compatibility(),
          extensionUi: { statuses: [] },
          tree: [],
        } satisfies ConversationSnapshot;
      }, BACKGROUND_CONTEXT);
      // Context reads acquire the Session line themselves: never nest one in
      // the transcript transaction. This accounting is an advisory projection.
      return {
        ...snapshot,
        usage: { ...snapshot.usage, cakeChatContext: await engine.contextStatus(selected) },
      };
    },
    async prompt(
      text,
      delivery,
      attachments,
      markdown,
      turnId,
      _presentation,
      _title,
      responseMode,
      internal,
    ) {
      if (disposed) throw new Error("Coordinator has closed");
      const submission = await admit(
        text,
        delivery,
        attachments,
        turnId,
        markdown,
        undefined,
        responseMode,
        internal,
      );
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (turnId && settled.status !== "unanswered") {
        // Attribute the final answer to the latest consumed conversational input,
        // not necessarily the request that initially started a steered run.
        const snapshot = await runtime.snapshot();
        const latestInput = snapshot.parts.findLast(
          (part) => part.kind === "text" && part.role === "user" && !part.deliveryState,
        );
        const answer = snapshot.parts.findLast(
          (part) => part.kind === "text" && part.role === "assistant",
        );
        options.onTurnResult?.(turnId, {
          stopReason: "stop",
          entryId: answer?.kind === "text" ? answer.entryId : undefined,
          text: answer?.kind === "text" ? answer.text : "",
          respondsToSessionId:
            latestInput?.kind === "text" ? latestInput.crossSession?.sender.sessionId : undefined,
        });
      }
      if (settled.status === "unanswered") {
        if (settled.reason === "aborted") throw new TurnCanceledError();
        throw new Error(
          settled.detail === undefined
            ? (settled.reason ?? "Coordinator could not answer")
            : JSON.stringify(settled.detail),
        );
      }
    },
    async notifySubagentCompletion(result, completionId) {
      const parsed = Schema.decodeUnknownOption(SubagentResult)(result);
      const provenance: SubagentReportOrigin | undefined = Option.isSome(parsed)
        ? Schema.decodeUnknownSync(SubagentReportOrigin)(parsed.value)
        : undefined;
      const submission = await admit(
        subagentCompletionMessage(result),
        "follow-up",
        [],
        completionId,
        true,
        provenance,
      );
      await submission.wait(BACKGROUND_CONTEXT);
    },
    ...queueOperations,
    async setUserMessageMarkdown(entryId, markdown) {
      if (disposed) throw new Error("The Cake runtime has been disposed");
      await setDurableUserMessageMarkdown(engine.root, entryId, markdown);
    },
    async compact(instructions) {
      const job = await engine.root.compact(instructions, BACKGROUND_CONTEXT);
      await engine.harness.waitForTask(job, BACKGROUND_CONTEXT);
    },
    async abort() {
      await abortDurableActiveTurn(engine.harness, engine.root);
    },
    async setModel(provider, modelId) {
      const model = catalogRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`Unknown model ${provider}/${modelId}`);
      selected = model;
      activePreset = undefined;
      unavailableModel = undefined;
      await configureAgent();
      publish();
    },
    async setThinkingLevel(level) {
      thinkingLevel = level;
      await configureAgent();
      publish();
    },
    async applyConfiguration(configuration: ChatConfiguration) {
      const model = catalogRuntime.getModel(configuration.provider, configuration.modelId);
      if (!model)
        throw new Error(`Unknown model ${configuration.provider}/${configuration.modelId}`);
      selected = model;
      unavailableModel = undefined;
      activePreset = configuration.preset;
      thinkingLevel = configuration.thinkingLevel;
      fastMode = configuration.fastMode;
      await options.fastMode?.set(fastMode);
      await configureAgent();
      publish();
    },
    async setFastMode(enabled) {
      fastMode = enabled;
      await options.fastMode?.set(enabled);
      publish();
    },
    async syncFastMode() {
      fastMode = options.fastMode?.get() ?? false;
      publish();
    },
    async setPiSetting(update: PiSettingUpdate) {
      applyPiSetting(settings, update);
      publish();
    },
    async callCakeOperation(
      command: string,
      input: JsonObject,
      signal: AbortSignal,
    ): Promise<JsonValue> {
      const result = await operations.invoke(
        { command, input },
        { signal, toolCallId: randomUUID(), runtime },
      );
      return result.structuredContent;
    },
    async refreshModels() {
      await catalogRuntime.refresh();
      models.synchronizeProviders();
      modelOptions = await projectModels();
      publish();
    },
    async reload() {
      // Global settings reload includes Cake Chat, but is not a Project Session edit.
      // Durable keeps its engine/history; its settings getters read this manager live.
      await commands.reload();
      const errors = settings.drainErrors();
      if (errors.length) throw new Error(errors.map((error) => error.error.message).join("\n"));
      await configureAgent();
      publish();
    },
    rename: unsupported,
    // Forks only ever become side chats; Cake Chat itself stays one permanent conversation.
    async fork(entryId) {
      return { sessionId: await sideChats.fork(entryId), sessionFile, artifactPointers: [] };
    },
    toolCompact: unsupported,
    navigate: unsupported,
    async dispose() {
      disposed = true;
      await publishing;
      try {
        await engine.close();
      } finally {
        await mcp.close();
      }
    },
  };
  // Durable reuses the persisted agent on reopen. Apply only the external instruction authority;
  // the model/thinking selection remains the saved coordinator's configuration.
  const savedAgent = await engine.root.agent(BACKGROUND_CONTEXT);
  if (savedAgent.model) {
    const saved = catalogRuntime.getModel(savedAgent.model.provider, savedAgent.model.modelId);
    unavailableModel = saved
      ? undefined
      : { provider: savedAgent.model.provider, modelId: savedAgent.model.modelId };
    selected = saved ?? selected;
  }
  thinkingLevel = savedAgent.thinkingLevel ?? thinkingLevel;
  const savedPreset = await engine.harness.snapshot(
    PresetContextDoc,
    engine.root.id,
    BACKGROUND_CONTEXT,
  );
  activePreset = savedPreset
    ? Schema.decodeUnknownSync(PresetState)(savedPreset).preset
    : newCoordinator && preset
      ? { id: preset.id, ...(preset.prompt === undefined ? null : { prompt: preset.prompt }) }
      : undefined;
  await configureAgent();
  engine.harness.resume();
  return runtime;
}
