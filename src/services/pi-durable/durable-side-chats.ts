import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import {
  AgentDoc,
  InboxDoc,
  LiveDoc,
  SystemEntry,
  UsageDoc,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryQuery,
  type Harness,
  type InboxItem,
  type Storage,
  type Tx,
} from "@earendil-works/pi-durable";
import { randomUUID } from "node:crypto";
import {
  cakeChatSideChatConversationId,
  cakeChatSideChatSessionId,
} from "../../contracts/cake-chats/cake-chat-identity";
import type {
  ConversationSnapshot,
  PiSessionPreview,
  UiPart,
} from "../../contracts/conversations/session-contract";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { applyPiSetting, projectPiSettings } from "../pi/runtime/settings-translation";
import { projectSessionEntries, queuedUserMessageDisplay } from "../pi/runtime/session-projection";
import { TurnCanceledError } from "../pi/runtime/RuntimeTurnCompletion";
import type {
  CakeSessionRuntime,
  CakeSessionRuntimeOptions,
} from "../pi/runtime/cake-session-runtime";
import { supportsFastMode } from "../pi/fast-mode";
import { changeConversation } from "./durable-chat-engine";
import { readDurableOriginalPage } from "./durable-chat-history";
import { abortDurableActiveTurn, startDurableQueuedInput } from "./durable-chat-queue";
import {
  DURABLE_SIDE_CHAT_NOTE,
  durableInputText,
  durableQueuedDisplayText,
  durableQueuedInput,
  durableQueuedText,
  markDurableInputSteering,
  withoutDurableSideChatNote,
} from "./durable-input-presentation";

const ORIGINALS = ["pi.user", "pi.assistant", "pi.tool-result"];
const NO_REPLY = "That Cake Chat message has no completed reply to branch from yet";

/** What a side chat shares with the live Cake Chat coordinator that owns the database. */
export interface DurableSideChatHost {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly storage: Storage;
  readonly sessionFile: string;
  readonly catalog: Pick<ModelRuntime, "getModel">;
  readonly settings: SettingsManager;
  readonly models: () => ConversationSnapshot["models"];
  readonly fastMode: () => boolean;
}

export interface DurableSideChats {
  /** Forks Cake Chat after the exchange that contains `entryId`; returns the side chat's session ID. */
  fork(entryId: string): Promise<string>;
  /** The Cake conversation runtime of one existing side-chat fork. */
  open(options: CakeSessionRuntimeOptions): Promise<CakeSessionRuntime>;
  preview(sessionId: string): Promise<PiSessionPreview | undefined>;
}

/**
 * The entry a side chat forks at: the completed assistant reply that closes the anchored
 * exchange. Forking there gives the side chat exactly the context Cake Chat's next request
 * would extend, never a dangling tool call.
 */
async function sideChatForkPoint(root: Conversation, entryId: string): Promise<EntryId> {
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
  /** Fork conversation and its inclusive fork point, for an ID this Cake Chat owns. */
  const resolve = async (sessionId: string | undefined) => {
    const id = cakeChatSideChatConversationId(sessionId);
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
  /** The side chat's own entries; the inherited Cake Chat prefix is model context only. */
  const ownEntries = (
    scan: (
      query: Omit<EntryQuery, "conversationId">,
      limit: number,
      cursor: Parameters<Conversation["entries"]>[2],
    ) => ReturnType<Conversation["entries"]>,
    after: EntryId,
  ): Pick<Conversation, "entries"> => ({
    entries: async (query, limit, cursor) => {
      // SAFETY: entry IDs are integers; every own entry is newer than the fork point.
      const page = await scan({ ...query, minEntryId: (after + 1) as EntryId }, limit, cursor);
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
    const sessionId = cakeChatSideChatSessionId(conversation.id);
    let disposed = false;
    let streaming = false;
    let activeTurnIds: string[] = [];
    const inbox = async () =>
      (await harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT))?.items ?? [];
    const queued = async () => {
      const items = await inbox();
      const lane = (mode: InboxItem["mode"]) =>
        items
          .filter((item): item is Extract<InboxItem, { content: unknown }> => item.mode === mode)
          .map((item) => durableQueuedDisplayText(item.content));
      return { steering: lane("steer"), followUp: lane("followUp") };
    };
    const requestId = async (item: InboxItem) =>
      (await storage.submission(item.id, BACKGROUND_CONTEXT))?.requestId ?? String(item.id);
    const itemFor = async (partId: string) => {
      for (const item of await inbox())
        if (partId === `queued-${await requestId(item)}` || partId === (await requestId(item)))
          return item;
      throw new Error("That queued message no longer exists");
    };
    const history = (cursor?: string) =>
      readDurableOriginalPage(
        ownEntries(
          (query, limit, next) => conversation.entries(query, limit, next, BACKGROUND_CONTEXT),
          after,
        ),
        cursor,
      );
    const configure = async (change: {
      readonly model?: { readonly provider: string; readonly modelId: string };
      readonly thinkingLevel?: Parameters<CakeSessionRuntime["setThinkingLevel"]>[0];
    }) => {
      if (change.model && !host.catalog.getModel(change.model.provider, change.model.modelId))
        throw new Error(`Unknown model ${change.model.provider}/${change.model.modelId}`);
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
      publish();
    };
    const runtime: CakeSessionRuntime = {
      sessionId,
      sessionFile: host.sessionFile,
      get streaming() {
        return streaming;
      },
      executingTurnIds: () => activeTurnIds,
      recordReviewRun() {
        throw new Error("Project review runs do not belong to Cake Chat side chats");
      },
      history,
      async queueCommand() {
        throw new Error("Queued Pi slash commands are available only in Project Sessions");
      },
      async inspectSession() {
        throw new Error("Transcript queries are unavailable in Cake Chat side chats");
      },
      async snapshot() {
        return conversation.commit(async (tx) => {
          const page = await readDurableOriginalPage(
            ownEntries(
              (query, limit, cursor) =>
                tx.scanEntries({ ...query, conversationId: conversation.id }, limit, cursor),
              after,
            ),
          );
          const live = await tx.doc(LiveDoc, conversation.id);
          const agent = await tx.doc(AgentDoc, conversation.id);
          const usage = await tx.doc(UsageDoc, conversation.id);
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
              const display = queuedUserMessageDisplay(durableQueuedText(item.content));
              parts.push({
                id: `queued-${id}`,
                kind: "text",
                role: "user",
                text: display.text,
                status: "complete",
                deliveryState: item.mode === "steer" ? "steering" : "queued",
                renderAs: display.renderAs,
                crossSession: display.crossSession,
                queuedInput: durableQueuedInput(item, id),
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
            fastMode: host.fastMode() && selected !== undefined && supportsFastMode(selected),
            fastModeAvailable: false,
            piSettings: projectPiSettings(host.settings),
            diagnostics: [],
            commands: [],
            usage: { tokens, cost: sums.reduce((sum, use) => sum + use.cost.total, 0) },
            compatibility: { resources: [], diagnostics: [] },
            extensionUi: { statuses: [] },
            tree: [],
          } satisfies ConversationSnapshot;
        }, BACKGROUND_CONTEXT);
      },
      async prompt(text, delivery, attachments, markdown = false, turnId) {
        if (disposed) throw new Error("Cake Chat side chat has closed");
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
          (await history()).parts.length === 0;
        const submission = await conversation.submit(
          {
            type: "input",
            content: [
              { type: "text", text: durableInputText(text, attachments, markdown, busy) },
              ...(first ? [{ type: "text" as const, text: DURABLE_SIDE_CHAT_NOTE }] : []),
            ],
            requestId: turnId ?? randomUUID(),
            whenBusy: delivery === "steer" ? "steer" : "followUp",
          },
          BACKGROUND_CONTEXT,
        );
        const settled = await submission.wait(BACKGROUND_CONTEXT);
        if (settled.status === "unanswered") {
          if (settled.reason === "aborted") throw new TurnCanceledError();
          throw new Error(
            settled.detail === undefined
              ? (settled.reason ?? "Side chat could not answer")
              : JSON.stringify(settled.detail),
          );
        }
      },
      listQueuedMessages: queued,
      async pendingMessages() {
        const items = (await inbox()).filter((item) => item.mode !== "write");
        return {
          items: await Promise.all(
            items.map(async (item, index) => {
              const id = await requestId(item);
              const text = durableQueuedText(item.content);
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
      async reorderPendingMessage(input) {
        const item = await itemFor(input.itemId);
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(InboxDoc, conversation.id);
          const index = doc.items.findIndex((entry) => entry.id === item.id);
          if (index < 0) throw new Error("That message was already consumed");
          const [moved] = doc.items.splice(index, 1);
          const positions = doc.items.flatMap((entry, position) =>
            entry.mode === item.mode ? [position] : [],
          );
          doc.items.splice(positions[input.position - 1] ?? doc.items.length, 0, moved!);
        }, BACKGROUND_CONTEXT);
        return runtime.pendingMessages();
      },
      async clearQueue() {
        for (const item of await inbox())
          if (item.mode !== "write")
            await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
        return queued();
      },
      async cancelSteering() {
        for (const item of await inbox())
          if (item.mode === "steer")
            await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
        return queued();
      },
      async removeQueuedMessage(partId) {
        const item = await itemFor(partId);
        const result = await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
        if (result === "already_placed") throw new Error("That message was already consumed");
        return queued();
      },
      async steerQueuedMessage(partId) {
        const item = await itemFor(partId);
        await conversation.commit(async (tx) => {
          const doc = await tx.doc(InboxDoc, conversation.id);
          const queuedItem = doc.items.find((entry) => entry.id === item.id);
          if (!queuedItem || queuedItem.mode === "write")
            throw new Error("That message was already consumed");
          queuedItem.mode = "steer";
          if (typeof queuedItem.content === "string")
            queuedItem.content = markDurableInputSteering(queuedItem.content);
          else {
            const block = queuedItem.content.find((entry) => entry.type === "text");
            if (block?.type === "text") block.text = markDurableInputSteering(block.text);
          }
        }, BACKGROUND_CONTEXT);
        return queued();
      },
      async sendQueuedMessageNow(partId) {
        const item = partId
          ? await itemFor(partId)
          : (await inbox()).find((entry) => entry.mode !== "write");
        if (!item || item.mode === "write") throw new Error("No queued message to send");
        const abortedTurnIds = [...activeTurnIds];
        await startDurableQueuedInput(harness, conversation, item.id);
        return { queued: await queued(), abortedTurnIds };
      },
      setUserMessageMarkdown: unsupported,
      async compact(instructions) {
        const job = await conversation.compact(instructions, BACKGROUND_CONTEXT);
        await harness.waitForTask(job, BACKGROUND_CONTEXT);
      },
      async abort() {
        await abortDurableActiveTurn(harness, conversation);
      },
      setModel: (provider, modelId) => configure({ model: { provider, modelId } }),
      setThinkingLevel: (thinkingLevel) => configure({ thinkingLevel }),
      applyConfiguration: (configuration) =>
        configure({
          model: { provider: configuration.provider, modelId: configuration.modelId },
          thinkingLevel: configuration.thinkingLevel,
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
        unsubscribe();
        await publishing;
      },
    };
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
    async fork(entryId) {
      const at = await sideChatForkPoint(root, entryId);
      // Durable assumes a head marker drops the system prompt, so a request whose context
      // has no `pi.system` entry after its head re-sends a complete baseline system message
      // (every section and tool again) after the history. Cake Chat's run resets carry the
      // current system message themselves; an empty marker in the fork's creating commit
      // lets Durable diff against that copy instead, so the fork's first request repeats
      // Cake Chat's prefix byte for byte and reads its prompt cache.
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
                init: async (tx: Tx, id: ConversationId) => {
                  await tx.appendEntry(SystemEntry, id, {});
                },
              }
            : null),
        },
        BACKGROUND_CONTEXT,
      );
      return cakeChatSideChatSessionId(fork.id);
    },
    open,
    async preview(sessionId) {
      const { conversation, after } = await resolve(sessionId);
      const page = await readDurableOriginalPage(
        ownEntries(
          (query, limit, cursor) => conversation.entries(query, limit, cursor, BACKGROUND_CONTEXT),
          after,
        ),
      );
      return {
        workspacePath: "",
        sessionId: cakeChatSideChatSessionId(conversation.id),
        sessionFile: host.sessionFile,
        parts: page.parts,
      };
    },
  };
}
