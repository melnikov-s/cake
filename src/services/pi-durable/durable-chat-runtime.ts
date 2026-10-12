import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
  type InboxItem,
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
import type { PiPendingMessageReorder } from "../../contracts/conversations/pending-message-data";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
} from "../../contracts/model-presets/cake-model-selection";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import {
  CakeOperationRegistry,
  cakeToolDescription,
  cakeToolEnvelopeSchema,
} from "../pi/runtime/cake-operation-registry";
import { applyPiSetting, projectPiSettings } from "../pi/runtime/settings-translation";
import {
  projectSessionEntries,
  parseContextAttachmentBlocks,
} from "../pi/runtime/session-projection";
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
import { readDurableOriginalPage } from "./durable-chat-history";

import { durableChatDatabase, purgeLegacyGlobalChatHistory } from "./durable-chat-location";
import { coordinatorSystemPrompt } from "./coordinator-system-prompt";
import { abortDurableActiveTurn, startDurableQueuedInput } from "./durable-chat-queue";
import { registerAgentDirectoryExtensionProviders } from "../pi/runtime/extension-providers";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-data";
import { SubagentResult } from "../../contracts/subagents/subagent-data";
import { Option } from "effect";
import {
  durableInputPresentation,
  durableInputText,
  markDurableInputSteering,
} from "./durable-input-presentation";
const presentationOf = (content: string | ReadonlyArray<{ type: string; text?: string }>) =>
  durableInputPresentation(
    typeof content === "string"
      ? content
      : content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n"),
  );
const textOf = (content: string | ReadonlyArray<{ type: string; text?: string }>) =>
  presentationOf(content).body;
const queuedInput = (item: Extract<InboxItem, { content: unknown }>, id: string) => {
  const input = presentationOf(item.content);
  const images =
    typeof item.content === "string"
      ? []
      : item.content
          .filter((block) => block.type === "image")
          .map((block, index) => ({
            kind: "image" as const,
            name: input.imageNames[index] ?? `Image ${index + 1}`,
            data: block.data,
            mimeType: block.mimeType,
          }));
  return {
    itemId: id,
    turnId: id,
    text: input.text,
    renderUserMessageAsMarkdown: input.markdown,
    attachments: [
      ...input.files,
      ...parseContextAttachmentBlocks(input.body).attachments,
      ...images,
    ],
  };
};
const unsupported = async () => {
  throw new Error(
    "The permanent Cake Chat cannot be forked, edited, renamed or navigated as a Project Session",
  );
};

/** The shared Cake conversation contract, backed solely by Pi Durable for the coordinator. */
export async function createDurableCakeChatRuntime(
  options: CakeSessionRuntimeOptions,
  inspection?: RequestInspection,
): Promise<CakeSessionRuntime> {
  if (!options.coordinator || !options.cakeChatMemory || options.sessionId !== CAKE_CHAT_SESSION_ID)
    throw new Error("Durable Cake Chat requires the coordinator capability profile");
  const preferences = options.cakeChatMemory;
  const sessionId = options.sessionId;
  const sessionFile = durableChatDatabase(options.sessionDir);
  const instructions = () => coordinatorSystemPrompt(preferences.preferences().instructions);
  const settings = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  const catalogRuntime = await ModelRuntime.create({
    authPath: join(options.agentDir, "auth.json"),
    modelsPath: join(options.agentDir, "models.json"),
    modelsStorePath: join(options.agentDir, "models-cache.json"),
  });
  let fastMode = options.fastMode?.get() ?? false;
  const providerDiagnostics = await registerAgentDirectoryExtensionProviders(
    options.agentDir,
    catalogRuntime,
  );
  const models = durableModels(catalogRuntime, () => fastMode, inspection);
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
  const diagnostics: string[] = [...providerDiagnostics];
  const resolveModel = (selection: CakeModelSelection | undefined): ExplicitCakeModelSelection => {
    const inherited = {
      provider: selected.provider,
      modelId: selected.id,
      thinkingLevel,
      fastMode,
    };
    if (options.resolveModelSelection) return options.resolveModelSelection(selection, inherited);
    if (typeof selection === "string")
      throw new Error("Model preset resolution is unavailable in this runtime");
    return { ...(selection ?? inherited) };
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
      const result = await operations.invoke(input, {
        signal: context.abortSignal ?? new AbortController().signal,
        toolCallId: api.callId,
        runtime: { sessionId, model: { provider: selected.provider, id: selected.id } },
        onUpdate: (value) => {
          void api.details(copyJson(value), context).catch(() => undefined);
        },
      });
      return { content: result.content, details: copyJson(result.details) };
    },
  });
  const zoom = defineTool({
    name: "zoom",
    description:
      "Open id+n into its two children; n=1 returns the original including images. Zoom before guessing from a vague summary.",
    parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
    replay: "safe",
    async execute(input, _api, context) {
      const result = await engine.memory.zoom(
        input.id,
        input.n,
        context.abortSignal ?? new AbortController().signal,
      );
      return {
        content: [
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
      return { content: [{ type: "text", text: new Date(timestamp).toISOString() }] };
    },
  });
  registry.install(defineExtension({ name: "cake-coordinator", tools: [cake, zoom, date] }));
  await mkdir(dirname(sessionFile), { recursive: true });
  // Clean start is intentional. These are the explicitly configured global namespace
  // roots, never a Project Session directory. SQLite is outside both deleted roots.
  await purgeLegacyGlobalChatHistory(options.sessionDir, options.resolvedSessionDir);
  const storage = await openNodeSqliteStorage(sessionFile);
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
      return settings.getCompactionSettings(selected);
    },
  };
  const engine = await openDurableChatEngine({
    storage,
    models,
    registry,
    settings: sdkSettings,
    agent: {
      model: { provider: selected.provider, modelId: selected.id },
      thinkingLevel,
      tools: [cake, zoom, date],
      instructions: instructions(),
    },
    memory: {
      budget: () => preferences.preferences().memoryViewBytes,
      summarize: (input) =>
        preferences.summarize({
          ...input,
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
  const inbox = async () =>
    (await engine.harness.snapshot(InboxDoc, engine.root.id, BACKGROUND_CONTEXT))?.items ?? [];
  const queued = async () => {
    const items = await inbox();
    return {
      steering: items
        .filter((item): item is Extract<InboxItem, { content: unknown }> => item.mode === "steer")
        .map((item) => textOf(item.content)),
      followUp: items
        .filter(
          (item): item is Extract<InboxItem, { content: unknown }> => item.mode === "followUp",
        )
        .map((item) => textOf(item.content)),
    };
  };
  const requestId = async (item: InboxItem) =>
    (await storage.submission(item.id, BACKGROUND_CONTEXT))?.requestId ?? String(item.id);
  const itemFor = async (partId: string) => {
    for (const item of await inbox())
      if (partId === `queued-${await requestId(item)}` || partId === (await requestId(item)))
        return item;
    throw new Error("That queued message no longer exists");
  };
  const history = (cursor?: string) => readDurableOriginalPage(engine.root, cursor);
  const configureAgent = async () => {
    await engine.root.configure(
      {
        model: unavailableModel ?? { provider: selected.provider, modelId: selected.id },
        thinkingLevel,
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
  ) => {
    // Defense in depth: no caller may submit payload-bearing attachments to the coordinator.
    if (attachments.some((attachment) => attachment.kind !== "input"))
      throw new Error("Cake Chat accepts attachment references only");
    // No `!` shell escape is parsed: all text is a literal model input, and no shell exists in the registry.
    await configureAgent();
    const busy =
      delivery === "steer" &&
      (await engine.harness.snapshot(LiveDoc, engine.root.id, BACKGROUND_CONTEXT))?.run !==
        undefined;
    const content = [
      { type: "text" as const, text: durableInputText(text, attachments, markdown, busy) },
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
  const runtime: CakeSessionRuntime = {
    sessionId,
    sessionFile,
    get streaming() {
      return streaming;
    },
    executingTurnIds: () => activeTurnIds,
    recordReviewRun() {
      throw new Error("Project review runs do not belong to the global coordinator");
    },
    history,
    async queueCommand() {
      throw new Error("Queued Pi slash commands are available only in Project Sessions");
    },
    async inspectSession() {
      throw new Error(
        "Pi transcript-tree queries are available only in Project Sessions; use coordinator history or zoom for Cake Chat originals",
      );
    },
    async snapshot() {
      // One Session-line read prevents a completed original and its stale live
      // preview from appearing together, or model/inbox facts from different commits.
      return engine.root.commit(async (tx) => {
        const page = await readDurableOriginalPage({
          entries: (query, limit, cursor) =>
            tx.scanEntries({ ...query, conversationId: engine.root.id }, limit, cursor),
        });
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
            const text = textOf(item.content);
            const crossSession = parseCrossSessionMessage(text);
            parts.push({
              id: `queued-${id}`,
              kind: "text",
              role: "user",
              text,
              status: "complete",
              deliveryState: item.mode === "steer" ? "steering" : "queued",
              crossSession: crossSession?.metadata,
              queuedInput: queuedInput(item, id),
            });
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
          fastModeAvailable: supportsFastMode(selected),
          piSettings: projectPiSettings(settings),
          diagnostics: [...diagnostics],
          commands: [],
          usage: { tokens, cost: sums.reduce((sum, use) => sum + use.cost.total, 0) },
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        } satisfies ConversationSnapshot;
      }, BACKGROUND_CONTEXT);
    },
    async prompt(text, delivery, attachments, _markdown, turnId) {
      if (disposed) throw new Error("Coordinator has closed");
      const submission = await admit(text, delivery, attachments, turnId, _markdown);
      const settled = await submission.wait(BACKGROUND_CONTEXT);
      if (settled.status === "unanswered") {
        if (settled.reason === "aborted") throw new TurnCanceledError();
        throw new Error(
          settled.detail === undefined
            ? (settled.reason ?? "Coordinator could not answer")
            : JSON.stringify(settled.detail),
        );
      }
    },
    async notifySubagentCompletion(result) {
      const parsed = Schema.decodeUnknownOption(SubagentResult)(result);
      const provenance = Option.isSome(parsed)
        ? `\n\nWorker provenance: ${JSON.stringify({ handleId: parsed.value.handleId, projectPath: parsed.value.projectPath, status: parsed.value.status, resolvedModel: parsed.value.resolvedModel, fastMode: parsed.value.fastMode, usage: parsed.value.usage })}`
        : "";
      const submission = await admit(
        subagentCompletionMessage(result) + provenance,
        "follow-up",
        [],
      );
      await submission.wait(BACKGROUND_CONTEXT);
    },
    listQueuedMessages: queued,
    async pendingMessages() {
      const items = (await inbox()).filter((item) => item.mode !== "write");
      return {
        items: await Promise.all(
          items.map(async (item, index) => {
            const id = await requestId(item);
            const text = textOf(item.content);
            return {
              itemId: id,
              partId: `queued-${id}`,
              lane: item.mode === "steer" ? ("steering" as const) : ("follow-up" as const),
              position: items.slice(0, index + 1).filter((other) => other.mode === item.mode)
                .length,
              state: "queued" as const,
              text,
              crossSession: parseCrossSessionMessage(text)?.metadata,
            };
          }),
        ),
      };
    },
    async reorderPendingMessage(input: PiPendingMessageReorder) {
      const item = await itemFor(input.itemId);
      await engine.root.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, engine.root.id);
        const index = doc.items.findIndex((entry) => entry.id === item.id);
        if (index < 0) throw new Error("That message was already consumed");
        const [moved] = doc.items.splice(index, 1);
        const positions = doc.items.flatMap((entry, position) =>
          entry.mode === item.mode ? [position] : [],
        );
        const target = positions[input.position - 1] ?? doc.items.length;
        doc.items.splice(target, 0, moved!);
      }, BACKGROUND_CONTEXT);
      return runtime.pendingMessages();
    },
    async clearQueue() {
      for (const item of await inbox())
        if (item.mode !== "write")
          await engine.harness.abortSubmission(item.id, BACKGROUND_CONTEXT, engine.root.id);
      return queued();
    },
    async cancelSteering() {
      for (const item of await inbox())
        if (item.mode === "steer")
          await engine.harness.abortSubmission(item.id, BACKGROUND_CONTEXT, engine.root.id);
      return queued();
    },
    async removeQueuedMessage(partId) {
      const item = await itemFor(partId);
      const result = await engine.harness.abortSubmission(
        item.id,
        BACKGROUND_CONTEXT,
        engine.root.id,
      );
      if (result === "already_placed") throw new Error("That message was already consumed");
      return queued();
    },
    async steerQueuedMessage(partId) {
      const item = await itemFor(partId);
      await engine.root.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, engine.root.id);
        const queuedItem = doc.items.find((entry) => entry.id === item.id);
        if (!queuedItem || queuedItem.mode === "write")
          throw new Error("That message was already consumed");
        queuedItem.mode = "steer";
        if (typeof queuedItem.content === "string")
          queuedItem.content = markDurableInputSteering(queuedItem.content);
        else
          for (const block of queuedItem.content)
            if (block.type === "text") block.text = markDurableInputSteering(block.text);
      }, BACKGROUND_CONTEXT);
      return queued();
    },
    async sendQueuedMessageNow(partId) {
      const item = partId
        ? await itemFor(partId)
        : (await inbox()).find((entry) => entry.mode !== "write");
      if (!item || item.mode === "write") throw new Error("No queued message to send");
      const abortedTurnIds = [...activeTurnIds];
      await startDurableQueuedInput(engine.harness, engine.root, item.id);
      return { queued: await queued(), abortedTurnIds };
    },
    setUserMessageMarkdown: unsupported,
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
    reload: unsupported,
    rename: unsupported,
    fork: unsupported,
    toolCompact: unsupported,
    navigate: unsupported,
    async dispose() {
      disposed = true;
      await publishing;
      await engine.close();
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
  await configureAgent();
  engine.harness.resume();
  return runtime;
}
