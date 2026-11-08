import { copyJson } from "@earendil-works/chord";
import { shutdownDiagnostics, shutdownResource } from "../diagnostics/shutdown-diagnostics";
import { TaskAttributionDoc } from "./durable-task-attribution";
import { taskAttributionOperations } from "./durable-task-attribution-operations";
import {
  listDurableMessageReferences,
  readDurableMessageReference,
} from "./durable-message-references";
import { toJsonValue } from "../../utils/to-json-value";
import { Schema } from "effect";
import { CakeOperationRegistry } from "../pi/runtime/cake-operation-registry";
import type { PresetContext } from "../../contracts/model-presets/preset-context";
import { PresetContextDoc } from "./durable-preset-context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  AgentDoc,
  AssistantEntry,
  InboxDoc,
  LiveDoc,
  SystemEntry,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryQuery,
  type Harness,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { estimateContextTokens } from "@earendil-works/pi-durable-ai/utils/estimate";
import { randomUUID } from "node:crypto";
import {
  CAKE_CHAT_SESSION_ID,
  cakeChatSideChatParentId,
  cakeChatSideChatConversationId,
  cakeChatSideChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type {
  ConversationSnapshot,
  PiSessionPreview,
  UiPart,
} from "../../contracts/conversations/session-contract";
import { applyPiSetting, projectPiSettings } from "../pi/runtime/settings-translation";
import { projectSessionEntries } from "../pi/runtime/session-projection";
import { TurnCanceledError, TurnDetachedError } from "../pi/runtime/RuntimeTurnCompletion";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../pi/runtime/cake-session-runtime";
import { supportsFastMode } from "../pi/fast-mode";
import { changeConversation, markSystemCarried } from "./durable-chat-engine";
import {
  readDurableActiveInterviews,
  readDurableActiveTools,
  readDurableOriginalPage,
} from "./durable-chat-history";
import { createDurableSideChatInterview } from "./durable-side-chat-interviews";
import { durableAssistantEntryId } from "./durable-operation-context";
import {
  setDurableUserMessageMarkdown,
  UserMessagePresentationDoc,
} from "./durable-message-presentation";
import { abortDurableActiveTurn, createDurableConversationQueue } from "./durable-chat-queue";
import { createDurableTurnStop } from "./durable-turn-stop";
import {
  DURABLE_SIDE_CHAT_NOTE,
  durableInputText,
  durableQueuedParts,
  withoutDurableSideChatNote,
} from "./durable-input-presentation";

import { transferDurableQueuedToSideChat } from "./durable-queued-side-chat";
import { exportDurableSideChatHistory } from "./durable-side-chat-history";

import { inspectDurableSideChatMessages } from "./durable-side-chat-messages";
import type { SessionInspectionQuery } from "../../contracts/conversations/session-query-data";
import { SideSessionDoc } from "./durable-side-session";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";

const ORIGINALS = ["pi.user", "pi.assistant", "pi.tool-result"];
const NO_REPLY = "That Cake Chat message has no completed reply to branch from yet";

/** What a side chat shares with the live Cake Chat coordinator that owns the database. */
export interface DurableSideChatHost {
  readonly parentSessionId?: string;
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: Storage;
  readonly sessionFile: string;
  readonly catalog: Pick<ModelRuntime, "getModel">;
  readonly settings: SettingsManager;
  readonly models: () => ConversationSnapshot["models"];
  readonly fastMode: () => boolean;
  readonly todoContext?: () => string;
}

export interface DurableSideChats {
  /** Forks the main conversation after an anchored exchange, or its latest settled reply when omitted. */
  fork(entryId?: string): Promise<string>;
  transferQueued(sourceSessionId: string, targetSessionId: string, partId: string): Promise<string>;
  /** Task fork from an explicit or latest settled reply, with an isolated execution binding. */
  forkTask(
    workingDirectory: string,
    entryId?: string,
  ): Promise<{ sessionId: string; entryId: string }>;
  /** The Cake conversation runtime of one existing side-chat fork. */
  open(options: CakeSessionRuntimeOptions): Promise<CakeSessionRuntime>;
  preview(sessionId: string): Promise<PiSessionPreview | undefined>;
  inspectMessages(
    sessionId: string,
    query: SessionInspectionQuery,
  ): Promise<ReturnType<typeof toJsonValue>>;
  /** The inherited tool may dispatch only to an exactly opened fork's interview capability. */
  executeInterview: ReturnType<typeof createDurableSideChatInterview>;
  /** Dispatch with the originating authority and the opened fork's own identity. */
  executeCake: ReturnType<typeof createDurableSideChatInterview>;
}

/**
 * The entry a side chat forks at: the completed assistant reply that closes the anchored
 * exchange. Forking there gives the side chat exactly the context Cake Chat's next request
 * would extend, never a dangling tool call.
 */
async function sideChatForkPoint(root: Conversation, entryId?: string): Promise<EntryId> {
  if (entryId === undefined) {
    let cursor;
    do {
      const page = await root.entries({}, 64, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        const reply = entry.model?.find((message) => message.role === "assistant");
        if (
          entry.kind === "pi.assistant" &&
          reply?.role === "assistant" &&
          (reply.stopReason === "stop" || reply.stopReason === "length") &&
          !reply.content.some((block) => block.type === "toolCall")
        )
          return entry.id;
      }
      cursor = page.next;
    } while (cursor !== undefined);
    throw new Error(NO_REPLY);
  }
  const anchor = Number(entryId);
  if (!Number.isSafeInteger(anchor) || anchor < 0)
    throw new Error("That Cake Chat message is no longer available");
  let cursor;
  let found = false;
  do {
    const page = await root.entries(
      // SAFETY: validated as a nonnegative integer above; Durable entry IDs are such integers.
      { order: "ascending", minEntryId: anchor as EntryId },
      64,
      cursor,
      BACKGROUND_CONTEXT,
    );
    for (const entry of page.items) {
      if (!found) {
        if (entry.id !== anchor || !ORIGINALS.includes(entry.kind))
          throw new Error("That Cake Chat message is no longer available");
        found = true;
      } else if (entry.kind === "pi.user") throw new Error(NO_REPLY);
      const reply = entry.model?.find((message) => message.role === "assistant");
      if (
        entry.kind === "pi.assistant" &&
        reply?.role === "assistant" &&
        (reply.stopReason === "stop" || reply.stopReason === "length") &&
        !reply.content.some((block) => block.type === "toolCall")
      )
        return entry.id;
    }
    cursor = page.next;
  } while (cursor !== undefined);
  throw new Error(found ? NO_REPLY : "That Cake Chat message is no longer available");
}

const unsupported = async () => {
  throw new Error("Cake Chat side chats cannot be forked, edited, renamed or navigated");
};

export function createDurableSideChats(host: DurableSideChatHost): DurableSideChats {
  const { harness, root, storage } = host;
  // Capability handles only, owned by open sidecar runtimes and removed on dispose.
  const interviews = new Map<number, ReturnType<typeof createDurableSideChatInterview>>();
  const operations = new Map<number, CakeOperationRegistry>();
  /** Fork conversation and its inclusive fork point, for an ID this Cake Chat owns. */
  const resolve = async (sessionId: string | undefined) => {
    const id =
      cakeChatSideChatParentId(sessionId) === (host.parentSessionId ?? CAKE_CHAT_SESSION_ID)
        ? cakeChatSideChatConversationId(sessionId)
        : undefined;
    // SAFETY: Durable conversation IDs are nonnegative integers; the parser accepts only those.
    const record =
      id === undefined
        ? undefined
        : await storage.conversation(id as ConversationId, BACKGROUND_CONTEXT);
    const conversation =
      record === undefined ? undefined : await harness.conversation(record.id, BACKGROUND_CONTEXT);
    if (!record?.parent || record.parent.conversationId !== root.id || !conversation)
      throw new Error("That Cake Chat side chat no longer exists");
    return { conversation, after: record.parent.at };
  };
  /** Fork-aware originals; inherited entries remain Pi-owned history. */
  const displayEntries = (
    scan: (
      query: Omit<EntryQuery, "conversationId">,
      limit: number,
      cursor: Parameters<Conversation["entries"]>[2],
    ) => ReturnType<Conversation["entries"]>,
  ): Pick<Conversation, "entries"> => ({
    entries: async (query, limit, cursor) => {
      const page = await scan(query, limit, cursor);
      return {
        ...page,
        items: page.items.map((entry) =>
          entry.model
            ? { ...entry, model: entry.model.map((message) => withoutDurableSideChatNote(message)) }
            : entry,
        ),
      };
    },
  });

  const open = async (options: CakeSessionRuntimeOptions): Promise<CakeSessionRuntime> => {
    const { conversation, after } = await resolve(options.sessionId);
    const sessionId = cakeChatSideChatSessionId(conversation.id, host.parentSessionId);
    const task = await harness.snapshot(SideSessionDoc, conversation.id, BACKGROUND_CONTEXT);
    let disposed = false;
    let streaming = false;
    let activeTurnIds: string[] = [];
    let agentConfiguration = await harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
    if (options.interviewOperations)
      interviews.set(
        conversation.id,
        createDurableSideChatInterview(sessionId, options.interviewOperations),
      );
    const turnStop = createDurableTurnStop({
      stop: () => abortDurableActiveTurn(harness, conversation),
      onEvent: options.onEvent,
      publish: () => publish(),
      isDisposed: () => disposed,
    });
    const {
      inbox,
      requestId,
      operations: queueOperations,
    } = createDurableConversationQueue({
      harness,
      conversation,
      storage,
      kind: "side-chat",
      executingTurnIds: () => activeTurnIds,
      beforeSendNow: turnStop.beforeInput,
    });
    const history = (cursor?: string) =>
      conversation.commit(
        async (tx) =>
          readDurableOriginalPage(
            displayEntries((query, limit, next) =>
              tx.scanEntries({ ...query, conversationId: conversation.id }, limit, next),
            ),
            cursor,
            await readDurableActiveTools(tx, conversation.id),
            (await tx.doc(UserMessagePresentationDoc, conversation.id)).overrides,
            await readDurableActiveInterviews(tx, conversation.id),
            (await tx.doc(TaskAttributionDoc, conversation.id)).inputs,
            after,
          ),
        BACKGROUND_CONTEXT,
      );
    const configure = async (change: {
      readonly preset?: PresetContext;
      readonly model?: { readonly provider: string; readonly modelId: string };
      readonly thinkingLevel?: Parameters<CakeSessionRuntime["setThinkingLevel"]>[0];
    }) => {
      if (change.model && !host.catalog.getModel(change.model.provider, change.model.modelId))
        throw new Error(`Unknown model ${change.model.provider}/${change.model.modelId}`);
      if (change.model)
        await conversation.commit(async (tx) => {
          const state = await tx.doc(PresetContextDoc, conversation.id);
          if (change.preset) state.preset = change.preset;
          else delete state.preset;
        }, BACKGROUND_CONTEXT);
      const agent = await conversation.agent(BACKGROUND_CONTEXT);
      // The fork inherits Cake Chat's exact agent; an unchanged selection writes nothing,
      // so the system prompt and tools remain byte-identical to the parent's request.
      const model =
        change.model &&
        (agent.model?.provider !== change.model.provider ||
          agent.model.modelId !== change.model.modelId)
          ? change.model
          : undefined;
      const thinkingLevel =
        change.thinkingLevel !== undefined && change.thinkingLevel !== agent.thinkingLevel
          ? change.thinkingLevel
          : undefined;
      if (model || thinkingLevel)
        await conversation.configure(
          { ...(model ? { model } : null), ...(thinkingLevel ? { thinkingLevel } : null) },
          BACKGROUND_CONTEXT,
        );
      agentConfiguration = await harness.snapshot(AgentDoc, conversation.id, BACKGROUND_CONTEXT);
      publish();
    };
    const runtime: CakeSessionRuntime = {
      sessionId,
      sessionFile: host.sessionFile,
      get streaming() {
        return !turnStop.stopped() && streaming;
      },
      executingTurnIds: () => activeTurnIds,
      recordReviewRun() {
        throw new Error("Project review runs do not belong to Cake Chat side chats");
      },
      history,
      exportSideChatHistory: () => exportDurableSideChatHistory(conversation, sessionId, after),
      async queueCommand() {
        throw new Error("Queued Pi slash commands are available only in Project Sessions");
      },
      async inspectSession(query) {
        if (query.kind === "messages-list")
          return toJsonValue(await listDurableMessageReferences(conversation, sessionId, query));
        if (query.kind === "messages-read")
          return toJsonValue(await readDurableMessageReference(conversation, sessionId, query));
        throw new Error(
          "Pi transcript-tree queries are available only in Project Sessions; use history or archive recall for permanent chat originals",
        );
      },
      async snapshot() {
        // Durable's next-request context is fork-aware (unlike ownEntries) and
        // applies resets/edits. Its latest applicable request usage plus trailing
        // estimates describes active context, not UsageDoc's lifetime billing.
        const active = await conversation.context(BACKGROUND_CONTEXT).catch(() => undefined);
        const contextTokens = active ? estimateContextTokens(active.messages).tokens : undefined;
        const snapshot = await conversation.commit(async (tx) => {
          const page = await readDurableOriginalPage(
            displayEntries((query, limit, cursor) =>
              tx.scanEntries({ ...query, conversationId: conversation.id }, limit, cursor),
            ),
            undefined,
            await readDurableActiveTools(tx, conversation.id),
            (await tx.doc(UserMessagePresentationDoc, conversation.id)).overrides,
            await readDurableActiveInterviews(tx, conversation.id),
            (await tx.doc(TaskAttributionDoc, conversation.id)).inputs,
            after,
          );
          const live = await tx.doc(LiveDoc, conversation.id);
          const agent = await tx.doc(AgentDoc, conversation.id);
          const usage = await tx.doc(UsageDoc, conversation.id);
          const preset = (await tx.doc(PresetContextDoc, conversation.id)).preset;
          // tx.doc values are revocable drafts, even in read-only commits. Detach
          // the preset before the transaction settles and the snapshot reaches RPC.
          const presetSnapshot = preset === undefined ? undefined : { ...preset };
          const items = (await tx.doc(InboxDoc, conversation.id)).items;
          streaming = live?.run !== undefined;
          activeTurnIds = await Promise.all(
            (live?.run?.inputs ?? []).map(
              async (id) =>
                (await storage.submission(id, BACKGROUND_CONTEXT))?.requestId ?? String(id),
            ),
          );
          const ref = agent.model;
          const selected = ref ? host.catalog.getModel(ref.provider, ref.modelId) : undefined;
          const thinkingLevel = agent.thinkingLevel ?? "off";
          const parts: UiPart[] = [...page.parts];
          if (live?.generation?.message) {
            const message = live.generation.message;
            parts.push(
              ...projectSessionEntries(
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
              ).map((part) =>
                part.kind === "text" ? { ...part, status: "streaming" as const } : part,
              ),
            );
          }
          for (const item of items)
            if (item.mode !== "write") {
              const id = await requestId(item);
              parts.push(...durableQueuedParts(item, id));
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
            workspacePath: task?.workingDirectory ?? options.cwd,
            sessionId,
            sessionFile: host.sessionFile,
            sessionListed: false,
            parts,
            historyCursor: page.cursor,
            model: ref
              ? { provider: ref.provider, id: ref.modelId, name: selected?.name ?? ref.modelId }
              : undefined,
            models: host.models(),
            thinkingLevel,
            availableThinkingLevels: selected ? getSupportedThinkingLevels(selected) : ["off"],
            streaming,
            // Durable shares one request pipeline; fast mode follows Cake Chat.
            preset: presetSnapshot,
            fastMode: host.fastMode() && selected !== undefined && supportsFastMode(selected),
            fastModeAvailable: false,
            piSettings: projectPiSettings(host.settings),
            diagnostics: [],
            commands: [],
            usage: {
              tokens,
              cost: sums.reduce((sum, use) => sum + use.cost.total, 0),
              context: selected
                ? {
                    tokens: contextTokens ?? null,
                    contextWindow: selected.contextWindow,
                    percent:
                      contextTokens === undefined
                        ? null
                        : (contextTokens / selected.contextWindow) * 100,
                  }
                : undefined,
            },
            compatibility: { resources: [], diagnostics: [] },
            extensionUi: { statuses: [] },
            tree: [],
          } satisfies ConversationSnapshot;
        }, BACKGROUND_CONTEXT);
        return turnStop.project(snapshot);
      },
      async prompt(
        text,
        delivery,
        attachments,
        markdown = false,
        turnId,
        _presentationMode,
        _automaticTitle,
        _responseMode,
        internal,
      ) {
        if (disposed) throw new Error("Cake Chat side chat has closed");
        const assertCurrent = await turnStop.beforeInput();
        if (
          attachments.some(
            (attachment) => attachment.kind !== "input" && attachment.kind !== "annotation",
          )
        )
          throw new Error("Cake Chat side chats accept attachment references only");
        const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
        const busy = delivery === "steer" && live?.run !== undefined;
        // Orient the model once, on the side chat's first input, after the shared prefix.
        const first =
          live?.run === undefined &&
          (await inbox()).length === 0 &&
          (await history()).parts.every((part) => part.originalHistory);
        assertCurrent();
        const submission = await conversation.submit(
          {
            type: "input",
            content: [
              {
                type: "text",
                text: durableInputText(
                  text,
                  attachments,
                  markdown,
                  busy,
                  undefined,
                  undefined,
                  internal,
                  undefined,
                  false,
                  conversation.id,
                ),
              },
              ...(first
                ? [
                    {
                      type: "text" as const,
                      text: `${DURABLE_SIDE_CHAT_NOTE}\n${task?.workingDirectory ? `You are a read-only investigation context fork (inline/side session), not an implementation Project Session. Your tools run in the Cake-managed worktree ${task.workingDirectory}; tool availability does not authorize code changes. Read applicable project instruction files in this checkout before investigating project behavior; inherited chat context does not replace them. Never mutate this worktree or the source checkout. If code changes become needed, return findings to the parent for handoff to a fresh independent Project Session via sessions.create; never silently expand research into coding or redelegate it yourself. Cake delivers the correlated result automatically; no duplicate completion message.\n` : ""}Your parent/main conversation address is ${host.parentSessionId ?? CAKE_CHAT_SESSION_ID}. Your own messaging identity is ${sessionId}. Use cake sessions.send with input { sessionId: "parent", text: "..." } to message the parent.\n${host.todoContext?.() ?? ""}`,
                    },
                  ]
                : []),
            ],
            requestId: turnId ?? randomUUID(),
            whenBusy: delivery === "steer" ? "steer" : "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        const settled = await submission.wait(BACKGROUND_CONTEXT).catch((cause: unknown) => {
          throw new TurnDetachedError(cause instanceof Error ? cause.message : String(cause));
        });
        if (turnId && settled.status === "done" && settled.type === "input") {
          const answer = await conversation.commit(
            (tx) => tx.entry(AssistantEntry, settled.answer),
            BACKGROUND_CONTEXT,
          );
          const message = answer?.model?.find((item) => item.role === "assistant");
          const snapshot = await runtime.snapshot();
          const latestInput = snapshot.parts.findLast(
            (part) => part.kind === "text" && part.role === "user" && !part.deliveryState,
          );
          if (message?.role === "assistant")
            options.onTurnResult?.(turnId, {
              stopReason: message.stopReason,
              entryId: String(settled.answer),
              text: message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("\n"),
              respondsToSessionId:
                latestInput?.kind === "text"
                  ? latestInput.crossSession?.sender.sessionId
                  : undefined,
            });
        }
        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") throw new TurnCanceledError();
          throw new Error(
            settled.detail === undefined
              ? (settled.reason ?? "Side chat could not answer")
              : JSON.stringify(settled.detail),
          );
        }
      },
      ...queueOperations,
      async setUserMessageMarkdown(entryId, markdown) {
        if (disposed) throw new Error("Cake Chat side chat has closed");
        await setDurableUserMessageMarkdown(conversation, entryId, markdown);
      },
      async compact(instructions) {
        const job = await conversation.compact(instructions, BACKGROUND_CONTEXT);
        await harness.waitForTask(job, BACKGROUND_CONTEXT);
      },
      abort: turnStop.abort,
      setModel: (provider, modelId) => configure({ model: { provider, modelId } }),
      setThinkingLevel: (thinkingLevel) => configure({ thinkingLevel }),
      applyConfiguration: (configuration) =>
        configure({
          model: { provider: configuration.provider, modelId: configuration.modelId },
          thinkingLevel: configuration.thinkingLevel,
          ...(configuration.preset ? { preset: configuration.preset } : null),
        }),
      async setPiSetting(update) {
        applyPiSetting(host.settings, update);
        publish();
      },
      rename: unsupported,
      fork: unsupported,
      toolCompact: unsupported,
      navigate: unsupported,
      async dispose() {
        disposed = true;
        interviews.delete(conversation.id);
        operations.delete(conversation.id);
        unsubscribe();
        await shutdownDiagnostics.promise(
          "durable.sideChat.publication",
          shutdownResource(sessionId),
          () => publishing,
        );
      },
    };
    const coordinator = options.coordinator;
    if (coordinator) {
      operations.set(
        conversation.id,
        new CakeOperationRegistry(
          [
            ...coordinator.operations({
              sessionId,
              resolveModel: (selection, launch) => {
                if (!options.resolveModelSelection)
                  throw new Error("Model resolution is unavailable");
                return options.resolveModelSelection(
                  selection,
                  agentConfiguration?.model
                    ? {
                        provider: agentConfiguration.model.provider,
                        modelId: agentConfiguration.model.modelId,
                        thinkingLevel: agentConfiguration.thinkingLevel ?? "off",
                        fastMode: host.fastMode(),
                      }
                    : undefined,
                  launch,
                );
              },
              info: async () => ({
                sessionId,
                kind: "cake-chat",
                sessionFile: host.sessionFile,
                streaming,
              }),
              usage: async () =>
                Schema.decodeUnknownSync(Schema.Json)((await runtime.snapshot()).usage ?? {}),
              contextStatus: async () =>
                Schema.decodeUnknownSync(Schema.Json)(
                  (await runtime.snapshot()).usage?.context ?? {},
                ),
              compact: async () => {
                await runtime.compact();
                return { compacted: true };
              },
              setModel: (model) => runtime.applyConfiguration(model),
            }),
            ...taskAttributionOperations({
              conversation: () => conversation,
              todos: () => options.cakeChatTodos?.() ?? [],
            }),
          ],
          options.sessionReferences?.project,
        ),
      );
    }
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
        .catch(() => undefined)
        .finally(() => {
          publishing = undefined;
        });
    };
    const unsubscribe = harness.subscribeCommits((publication) => {
      if (publication.changes.some((change) => changeConversation(change) === conversation.id))
        queueMicrotask(publish);
    });
    return runtime;
  };

  return {
    async transferQueued(sourceSessionId, targetSessionId, partId) {
      const source =
        sourceSessionId === (host.parentSessionId ?? CAKE_CHAT_SESSION_ID)
          ? root
          : (await resolve(sourceSessionId)).conversation;
      const target = (await resolve(targetSessionId)).conversation;
      return transferDurableQueuedToSideChat({
        harness,
        storage,
        source,
        target,
        partId,
        parentSessionId: host.parentSessionId ?? CAKE_CHAT_SESSION_ID,
        targetSessionId,
        todoContext: host.todoContext?.(),
      });
    },
    async inspectMessages(sessionId, query) {
      await resolve(sessionId);
      return inspectDurableSideChatMessages(storage, sessionId, query);
    },
    async executeCake(input, api, context) {
      const registry = operations.get(api.conversationId);
      if (!registry)
        throw new Error("Cake controls are unavailable in this closed or unsupported side chat");
      const result = await registry.invoke(input, {
        signal: context.abortSignal ?? new AbortController().signal,
        toolCallId: api.callId,
        runtime: {
          sessionId: cakeChatSideChatSessionId(api.conversationId, host.parentSessionId),
          assistantEntryId: await durableAssistantEntryId(api, context),
        },
        onUpdate: (value) => {
          void api.details(copyJson(value), context).catch(() => undefined);
        },
      });
      return { output: result.content, details: copyJson(result.details) };
    },
    async executeInterview(input, api, context) {
      const dispatch = interviews.get(api.conversationId);
      if (!dispatch)
        throw new Error("Interviews are unavailable in this closed or unsupported side chat");
      return dispatch(input, api, context);
    },
    async forkTask(workingDirectory, entryId) {
      let at: EntryId | undefined;
      if (entryId !== undefined) at = await sideChatForkPoint(root, entryId);
      else {
        let cursor;
        do {
          const page = await root.entries({ order: "descending" }, 64, cursor, BACKGROUND_CONTEXT);
          for (const entry of page.items) {
            const reply = entry.model?.find((message) => message.role === "assistant");
            if (
              entry.kind === "pi.assistant" &&
              reply?.role === "assistant" &&
              (reply.stopReason === "stop" || reply.stopReason === "length") &&
              !reply.content.some((block) => block.type === "toolCall")
            ) {
              at = entry.id;
              break;
            }
          }
          cursor = page.next;
        } while (at === undefined && cursor !== undefined);
      }
      if (at === undefined) throw new Error(NO_REPLY);
      const sessionId = await this.fork(String(at));
      const { conversation } = await resolve(sessionId);
      const inherited = await conversation.agent(BACKGROUND_CONTEXT);
      await conversation.configure(
        {
          cwd: workingDirectory,
          tools: [...inherited.callable, createEditTool(), createWriteTool()],
        },
        BACKGROUND_CONTEXT,
      );
      await conversation.commit(async (tx) => {
        (await tx.doc(SideSessionDoc, conversation.id)).workingDirectory = workingDirectory;
      }, BACKGROUND_CONTEXT);
      return { sessionId, entryId: String(at) };
    },
    async fork(entryId) {
      const at = await sideChatForkPoint(root, entryId);
      // Forks from history written before Cake Chat marked its resets need the marker
      // themselves; see markSystemCarried.
      const view = await root.context(BACKGROUND_CONTEXT, { at });
      const systemCarried =
        view.head?.model?.[0]?.role === "system" &&
        !view.entries.some((entry) => SystemEntry.is(entry) && entry.id > view.head!.id);
      const fork = await root.fork(
        at,
        {
          ownership: { kind: "ownerless" },
          ...(systemCarried
            ? {
                init: (tx: Tx, id: ConversationId) => markSystemCarried(tx, id),
              }
            : null),
        },
        BACKGROUND_CONTEXT,
      );
      return cakeChatSideChatSessionId(fork.id, host.parentSessionId);
    },
    open,
    async preview(sessionId) {
      const { conversation, after } = await resolve(sessionId);
      const page = await conversation.commit(
        async (tx) =>
          readDurableOriginalPage(
            displayEntries((query, limit, cursor) =>
              tx.scanEntries({ ...query, conversationId: conversation.id }, limit, cursor),
            ),
            undefined,
            await readDurableActiveTools(tx, conversation.id),
            (await tx.doc(UserMessagePresentationDoc, conversation.id)).overrides,
            await readDurableActiveInterviews(tx, conversation.id),
            (await tx.doc(TaskAttributionDoc, conversation.id)).inputs,
            after,
          ),
        BACKGROUND_CONTEXT,
      );
      return {
        workspacePath: "",
        sessionId: cakeChatSideChatSessionId(conversation.id, host.parentSessionId),
        sessionFile: host.sessionFile,
        parts: page.parts,
      };
    },
  };
}
