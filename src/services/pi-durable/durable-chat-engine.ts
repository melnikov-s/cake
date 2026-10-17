import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import {
  createAssistantMessageEventStream,
  type Models,
  type Message,
} from "@earendil-works/pi-durable-ai";
import { getCurrentSystemMessage } from "@earendil-works/pi-durable-ai/utils/transcript";
import {
  Harness,
  LiveDoc,
  ProviderDoc,
  ResetEntry,
  SystemEntry,
  defineDoc,
  type CommitChange,
  type Conversation,
  type ConversationId,
  type EntryId,
  type Registry,
  type Storage,
  type AgentChange,
  type HarnessOptions,
  type HarnessSettings,
  type Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { ChatMetadataDoc } from "./durable-chat-metadata";
import { createDurableChatMemory, type DurableMemoryOptions } from "./durable-chat-memory";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";
import { durableModelFacade } from "./durable-model-facade";
import { durableContextInspection } from "./durable-context-inspection";

const Boundary = Schema.Struct({ input: Schema.Int, marker: Schema.Int });
type Boundary = Schema.Schema.Type<typeof Boundary>;
const BoundaryDoc = defineDoc<Boundary>({
  kind: "cake.chat-run-boundary",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ input: -1, marker: -1 }),
});

/** The conversation one committed change belongs to; undefined for Session documents. */
export const changeConversation = (change: CommitChange) =>
  change.type === "document" || change.type === "document.copy"
    ? change.conversationId
    : change.type === "conversation"
      ? change.value.id
      : change.value.conversationId;

/**
 * Durable assumes a head marker drops the system prompt: when no `pi.system` entry follows
 * the newest head, its next request re-sends a complete baseline system message (every
 * section and tool) after the history, breaking the cached prefix. Cake Chat's resets carry
 * the current system message themselves, so an empty marker after one lets Durable diff
 * against that copy instead and emit a patch only when the prompt or tools really change.
 */
export const markSystemCarried = async (tx: Tx, conversationId: ConversationId) => {
  await tx.appendEntry(SystemEntry, conversationId, {});
};

/** Durable's inbox owns acceptance/steering/follow-ups. Only the provider-request boundary
 * changes: first request of each independent run gets a persisted fresh context. Failures
 * here become model errors, never an ignored extension hook that sends lifetime history. */
export async function openDurableChatEngine(options: {
  storage: Storage;
  models: Models;
  registry: Registry;
  agent?: AgentChange;
  memory: DurableMemoryOptions;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  onChanged(): void;
  onReport(error: unknown): void;
}) {
  const closing = new AbortController();
  let root: Conversation;
  let memory: ReturnType<typeof createDurableChatMemory>;
  // A single SDK-boundary worker serializes indexing with request preparation. It does not
  // cache nodes/originals or own model runs; the Harness owns those persisted tasks.
  let worker = Promise.resolve();
  const index = (signal: AbortSignal, cutoff?: EntryId) => {
    const result = worker.then(() => {
      signal.throwIfAborted();
      return memory.synchronize(signal, cutoff);
    });
    worker = result.then(
      () => undefined,
      () => undefined,
    );
    // Stop must release request preparation even if an earlier background summary
    // still owns the worker. Keep indexing serialized, and skip cancelled work
    // when it eventually reaches the front of the queue.
    return awaitWithContext(result, withAbortSignal(signal, BACKGROUND_CONTEXT));
  };
  const models = durableModelFacade(options.models, {
    streamSimple(model, request, streamOptions) {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        const signal = streamOptions?.signal
          ? AbortSignal.any([closing.signal, streamOptions.signal])
          : closing.signal;
        const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
        // Side-chat forks share this Harness. Durable gives every fork a fresh provider
        // identity, so a request under another identity is a fork's: it sends exactly the
        // context Durable prepared and never touches Cake Chat's run boundary or memory.
        // At the wire it carries Cake Chat's identity, as Project Session forks share their
        // source's prompt cache key, so session-keyed provider caches serve its prefix too.
        const identity = await harness.snapshot(ProviderDoc, root.id, context);
        if (
          identity !== undefined &&
          streamOptions?.sessionId !== undefined &&
          streamOptions.sessionId !== identity.sessionId
        ) {
          const source = options.models.streamSimple(
            model,
            {
              messages: request.messages.map((message) => withoutDurableInputPresentation(message)),
            },
            { ...streamOptions, sessionId: identity.sessionId },
          );
          for await (const event of source) stream.push(event);
          return;
        }
        const live = await harness.snapshot(LiveDoc, root.id, context);
        const input = live?.run?.inputs[0];
        if (input !== undefined) {
          const boundary = await Schema.decodeUnknownPromise(Boundary)(
            (await harness.snapshot(BoundaryDoc, root.id, context)) ?? { input: -1, marker: -1 },
          );
          if (boundary.input !== input) {
            const submission = await options.storage.submission(input, context);
            if (!submission || submission.status !== "placed")
              throw new Error("Cake Chat input has no committed entry");
            const original = (await options.storage.entry(root.id, submission.entry, context))
              ?.entry;
            const steering = original?.model?.some(
              (message) =>
                message.role === "user" &&
                (typeof message.content === "string"
                  ? durableInputPresentation(message.content).steering
                  : message.content.some(
                      (block) =>
                        block.type === "text" && durableInputPresentation(block.text).steering,
                    )),
            );
            // Durable retains steering through tool rounds. At a final-answer boundary
            // it starts another task/run; retain Cake's active view for that continuation.
            if (steering && boundary.input >= 0) {
              await root.commit(async (tx) => {
                (await tx.doc(BoundaryDoc, root.id)).input = input;
              }, context);
            } else {
              // SAFETY: Durable's entry ids are nonnegative integer ids; the preceding inclusive bound excludes the new input.
              const cutoff = (submission.entry - 1) as EntryId;
              const current: Message[] = [];
              let cursor;
              do {
                const page = await root.entries(
                  { order: "ascending", minEntryId: submission.entry },
                  64,
                  cursor,
                  context,
                );
                for (const entry of page.items)
                  if (["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind))
                    current.push(...(entry.model ?? []));
                cursor = page.next;
              } while (cursor !== undefined);
              const system = getCurrentSystemMessage(request.messages);
              // Park a bounded active head before any slow or failing summary. Originals
              // remain on disk, so repeated summary outages cannot grow the active range.
              await root.commit(async (tx) => {
                await tx.appendEntry(ResetEntry, root.id, {
                  head: "self",
                  model: [...(system ? [system] : []), ...current],
                });
                if (system) await markSystemCarried(tx, root.id);
              }, context);
              const view = await index(signal, cutoff);
              const messages: Message[] = system ? [system] : [];
              messages.push(
                {
                  role: "user",
                  content: `${view.text}\n\n<current-time>Backend clock (UTC): ${new Date().toISOString()}</current-time>`,
                  timestamp: Date.now(),
                },
                ...current,
              );
              await root.commit(async (tx) => {
                const doc = await tx.doc(BoundaryDoc, root.id);
                const reset = await tx.appendEntry(ResetEntry, root.id, {
                  head: "self",
                  model: messages,
                });
                if (system) await markSystemCarried(tx, root.id);
                doc.input = input;
                doc.marker = reset.id;
              }, context);
            }
          }
        }
        signal.throwIfAborted();
        // Read the committed head even on recovery of a request whose old cutoff predates
        // the reset. Tool rounds and emergency compactions remain ordinary active context.
        const active = await root.context(context);
        const source = options.models.streamSimple(
          model,
          { messages: active.messages.map((message) => withoutDurableInputPresentation(message)) },
          streamOptions,
        );
        for await (const event of source) stream.push(event);
      })().catch((error: unknown) => {
        const aborted = closing.signal.aborted || streamOptions?.signal?.aborted;
        const message = {
          role: "assistant" as const,
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          stopReason: aborted ? ("aborted" as const) : ("error" as const),
          errorMessage: error instanceof Error ? error.message : String(error),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
      });
      return stream;
    },
  });
  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry: options.registry,
      settings: options.settings ?? { contextRetentionMs: 0 },
      ...(options.env ? { env: options.env } : null),
      onReport: options.onReport,
    },
    BACKGROUND_CONTEXT,
  );
  try {
    root = await harness.root(
      BACKGROUND_CONTEXT,
      options.agent ? { agent: options.agent } : undefined,
    );
    memory = createDurableChatMemory(harness, root, options.storage, options.memory);
    await root.commit(async (tx) => {
      await tx.doc(ChatMetadataDoc, root.id);
    }, BACKGROUND_CONTEXT);
    const unsubscribe = harness.subscribeCommits((publication) => {
      if (closing.signal.aborted) return;
      let cutoff: EntryId | undefined;
      let visible = false;
      let originals = 0;
      for (const change of publication.changes) {
        // Side-chat forks commit through this Harness too; only Cake Chat's own
        // changes count toward its metadata, memory index and snapshots.
        if (changeConversation(change) !== root.id) continue;
        if (
          change.type === "entry" &&
          ["pi.user", "pi.assistant", "pi.tool-result"].includes(change.value.kind)
        )
          originals += 1;
        if (change.type === "entry" && change.value.kind === "pi.assistant")
          cutoff = change.value.id;
        if (change.type === "entry" && !change.value.kind.startsWith("cake.chat-memory"))
          visible = true;
        if (
          change.type === "document" &&
          ["pi.live", "pi.inbox", "pi.agent", "pi.usage"].includes(change.record.kind)
        )
          visible = true;
      }
      if (originals > 0)
        queueMicrotask(() => {
          if (!closing.signal.aborted)
            void root
              .commit(async (tx) => {
                const metadata = await tx.doc(ChatMetadataDoc, root.id);
                metadata.messageCount += originals;
                metadata.modifiedAt = new Date().toISOString();
              }, BACKGROUND_CONTEXT)
              .catch(options.onReport);
        });
      if (visible) queueMicrotask(options.onChanged);
      if (cutoff !== undefined)
        queueMicrotask(() => {
          if (!closing.signal.aborted)
            void index(closing.signal, cutoff).catch((error: unknown) => {
              if (!closing.signal.aborted) options.onReport(error);
            });
        });
    });
    return {
      harness,
      root,
      memory,
      signal: closing.signal,
      storage: options.storage,
      index,
      async contextInspection(cwd: string) {
        const context = await root.context(BACKGROUND_CONTEXT);
        const boundary = await harness.snapshot(BoundaryDoc, root.id, BACKGROUND_CONTEXT);
        // Only Cake's committed memory reset supplies range handles. User-authored
        // lookalike markup (including copied clocks) is still an original message.
        const handoff =
          context.head?.id === boundary?.marker
            ? context.head?.model?.find((message) => message.role === "user")
            : undefined;
        return durableContextInspection(context.messages, cwd, handoff);
      },
      async close() {
        unsubscribe();
        // Mark the Harness closing first: a cancelled preparation must preserve
        // its request checkpoint, not settle it as an ordinary model error.
        const closed = harness.close(BACKGROUND_CONTEXT);
        closing.abort();
        await worker;
        await closed;
      },
    };
  } catch (error) {
    closing.abort();
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}
