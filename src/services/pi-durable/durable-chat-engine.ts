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
  type EntryRecord,
  type Registry,
  type Storage,
  type AgentChange,
  type HarnessOptions,
  type HarnessSettings,
  type Tx,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { isContextOverflow } from "@earendil-works/pi-durable-ai/utils/overflow";
import { anthropicCacheEstimate, durableCacheEvidence } from "./durable-cache-evidence";
import { ChatMetadataDoc } from "./durable-chat-metadata";
import { durableContextMetadata } from "./durable-context-metadata";
import { createDurableChatMemory, type DurableMemoryOptions } from "./durable-chat-memory";
import { withoutDurableInputPresentation } from "./durable-input-presentation";
import { DurableMemoryError, durableMemoryWork } from "./durable-memory-work";
import { durableModelFacade } from "./durable-model-facade";
import { durableContextInspection } from "./durable-context-inspection";
import { estimateContextTokens } from "@earendil-works/pi-durable-ai/utils/estimate";
import {
  cakeChatSummaryReason,
  type CakeChatContextStatus,
} from "../../contracts/cake-chats/context-policy";
import {
  ContextPolicy,
  ContextPolicyDoc,
  durableContextBreakdown,
  durableSystemFingerprint,
} from "./durable-context-policy";

const Boundary = Schema.Struct({
  input: Schema.Int,
  marker: Schema.Int,
  overflowInput: Schema.optionalKey(Schema.Int),
});
type Boundary = Schema.Schema.Type<typeof Boundary>;
const BoundaryDoc = defineDoc<Boundary>({
  kind: "cake.chat-run-boundary",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ input: -1, marker: -1 }),
});

/** Reserve output room against the model window, not the user's lower input cap.
 * Clamp the actual request output to the same reserve used for admission. */
export function durableAdmission(
  model: { contextWindow: number; maxTokens?: number },
  configured: number,
  requestedOutput?: number,
) {
  const reserve = Math.min(
    requestedOutput ??
      (model.maxTokens && model.maxTokens > 0 ? Math.min(model.maxTokens, 16_384) : 16_384),
    model.maxTokens && model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
    Math.max(1, model.contextWindow - 1),
  );
  return { reserve, limit: Math.max(1, Math.min(configured, model.contextWindow - reserve)) };
}

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

/** Durable owns the inbox and transcript. At the provider boundary, Cake keeps the
 * active prefix until cache uncertainty/expiry or the configured context limit. */
export async function openDurableChatEngine(options: {
  storage: Storage;
  models: Models;
  registry: Registry;
  agent?: AgentChange;
  memory: DurableMemoryOptions;
  contextLimitTokens?: () => number;
  now?: () => number;
  settings?: HarnessSettings;
  env?: HarnessOptions["env"];
  onChanged(): void;
  onReport(error: unknown): void;
}) {
  const closing = new AbortController();
  let root: Conversation;
  let memory: ReturnType<typeof createDurableChatMemory>;
  let activity: CakeChatContextStatus["activity"];
  const now = () => options.now?.() ?? Date.now();
  // A single SDK-boundary worker serializes indexing with request preparation. It does not
  // cache nodes/originals or own model runs; the Harness owns those persisted tasks.
  let worker = Promise.resolve();
  const index = (
    signal: AbortSignal,
    cutoff?: EntryId,
    budget?: number,
    batch: Parameters<typeof memory.synchronize>[3] = {},
  ) => {
    const work = batch.work ?? durableMemoryWork(signal);
    signal = work.signal;
    const result = worker.then(() => {
      signal.throwIfAborted();
      return memory.synchronize(signal, cutoff, budget, { ...batch, work });
    });
    worker = result.then(
      () => undefined,
      () => undefined,
    );
    // Stop must release request preparation even if an earlier aborted summary
    // still owns the worker. Keep indexing serialized, and skip cancelled work
    // when it eventually reaches the front of the queue.
    return awaitWithContext(result, withAbortSignal(signal, BACKGROUND_CONTEXT));
  };
  // One coalesced high-water mark, not one catch-up job per commit. Maintenance
  // runs only between coordinator runs with up to eight dependency-ready calls
  // and no work deadline. A later original or reopen resumes persisted
  // nodes; failure never spins an automatic retry loop. Keep this
  // inside the SDK's Promise/context lifecycle: Harness.close must cancel/drain
  // this same commit owner before closing storage, not an independent scheduler.
  let pendingCutoff: EntryId | undefined;
  let maintenance: Promise<void> | undefined;
  let maintenanceAbort: AbortController | undefined;
  let foreground = 0;
  const maintain = () => {
    if (closing.signal.aborted || foreground > 0 || maintenance || pendingCutoff === undefined)
      return;
    let consumed = false;
    let work: ReturnType<typeof durableMemoryWork> | undefined;
    maintenance = (async () => {
      if ((await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT))?.run) return;
      const cutoff = pendingCutoff;
      pendingCutoff = undefined;
      consumed = true;
      maintenanceAbort = new AbortController();
      work = durableMemoryWork(AbortSignal.any([closing.signal, maintenanceAbort.signal]));
      if (foreground === 0 && !(await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT))?.run)
        await index(work.signal, cutoff, undefined, { work });
    })()
      .catch((error: unknown) => {
        if (!closing.signal.aborted && !maintenanceAbort?.signal.aborted)
          options.onReport(
            new Error(
              `Cake Chat incremental memory maintenance paused: ${error instanceof DurableMemoryError ? error.reason : "preparation-failed"}; ${JSON.stringify(work?.metrics())}. Originals and committed progress are preserved.`,
            ),
          );
      })
      .finally(() => {
        maintenanceAbort = undefined;
        maintenance = undefined;
        if (consumed && pendingCutoff !== undefined) maintain();
      });
  };
  const models = durableModelFacade(options.models, {
    streamSimple(model, request, streamOptions) {
      const stream = createAssistantMessageEventStream();
      let preparing = true;
      let preparationWork: ReturnType<typeof durableMemoryWork> | undefined;
      foreground += 1;
      maintenanceAbort?.abort();
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
          preparing = false;
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
        let active = await root.context(context);
        const boundary = await Schema.decodeUnknownPromise(Boundary)(
          (await harness.snapshot(BoundaryDoc, root.id, context)) ?? { input: -1, marker: -1 },
        );
        const policy = await Schema.decodeUnknownPromise(ContextPolicy)(
          (await harness.snapshot(ContextPolicyDoc, root.id, context)) ?? { requestHead: null },
        );
        const previousRequest =
          policy?.requestHead === (active.head?.id ?? null) &&
          policy.requestSystem === durableSystemFingerprint(active.messages) &&
          policy?.request?.provider === model.provider &&
          policy.request.modelId === model.id
            ? policy.request
            : undefined;
        const { limit, reserve } = durableAdmission(
          model,
          options.contextLimitTokens?.() ?? 300_000,
          streamOptions?.maxTokens,
        );
        const before = durableContextBreakdown(active.messages);
        const reason = cakeChatSummaryReason(
          { ...before, limitTokens: limit, cache: previousRequest },
          now(),
        );
        const newInput = input !== undefined && boundary.input !== input;
        const reset = async (reason: "limit" | "cache-cold" | "cache-unknown" | "overflow") => {
          const readyOnly = reason === "cache-cold" || reason === "cache-unknown";
          preparing = true;
          preparationWork ??= durableMemoryWork(signal);
          const context = withAbortSignal(preparationWork.signal, BACKGROUND_CONTEXT);
          preparationWork.signal.throwIfAborted();
          if (input === undefined)
            throw new Error("Cannot recover context without a committed current input.");
          const submission = await options.storage.submission(input, context);
          if (!submission || submission.status !== "placed")
            throw new Error("Cake Chat input has no committed entry");
          const entries: EntryRecord[] = [];
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
                entries.push(entry);
            cursor = page.next;
          } while (cursor !== undefined);
          // On a large tool round, keep the latest call/results together. Older
          // completed rounds can enter memory without orphaning tool responses.
          let start = 0;
          if (reason === "limit")
            for (let i = 0; i < entries.length; i += 1)
              if (
                entries[i]?.model?.some(
                  (message) =>
                    message.role === "assistant" &&
                    message.content.some((block) => block.type === "toolCall"),
                )
              )
                start = i;
          // Even when compacting older completed tool rounds, never summarize away
          // the current user's input. Keep the latest call/results in original order.
          const tail = [
            ...entries.slice(0, start).filter((entry) => entry.kind === "pi.user"),
            ...entries.slice(start),
          ];
          const current = tail.flatMap((entry) => entry.model ?? []);
          // SAFETY: Durable entry ids are nonnegative integers. The inclusive
          // cutoff excludes the latest tool tail; earlier user inputs also stay verbatim.
          const cutoff = ((entries[start]?.id ?? submission.entry) - 1) as EntryId;
          const defer = async () => {
            // Cache freshness is not admission. Leave the active head intact
            // and let the idle owner resume the persisted rebuild after this run.
            if (pendingCutoff === undefined || pendingCutoff < cutoff) pendingCutoff = cutoff;
            await root.commit(async (tx) => {
              (await tx.doc(BoundaryDoc, root.id)).input = input;
            }, context);
          };
          const system = getCurrentSystemMessage(active.messages);
          const base = [...(system ? [system] : []), ...current];
          const remaining =
            limit -
            estimateContextTokens(base.map((message) => withoutDurableInputPresentation(message)))
              .tokens;
          if (remaining < 128) {
            if (readyOnly) return defer();
            throw new Error(
              "The current input, tools and instructions cannot fit the context limit. Shorten the input or raise the Cake Chat limit.",
            );
          }
          let hasHistory: boolean;
          let historyCursor;
          do {
            const page = await root.entries({ maxEntryId: cutoff }, 64, historyCursor, context);
            hasHistory = page.items.some((entry) =>
              ["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind),
            );
            historyCursor = page.next;
          } while (!hasHistory && historyCursor !== undefined);
          if (!hasHistory && reason === "overflow")
            throw new Error(
              "Provider context overflow: the current input, tools and instructions cannot be reduced safely. Shorten the input.",
            );
          if (!hasHistory && reason !== "limit") {
            await root.commit(async (tx) => {
              (await tx.doc(BoundaryDoc, root.id)).input = input;
            }, context);
          } else {
            activity = "summarizing";
            options.onChanged();
            try {
              // Publish a replacement head only after its complete view is persisted.
              // Failed preparation leaves the existing head (and cache evidence) intact.
              const budget = Math.min(
                options.memory.budget(),
                Math.floor(((remaining - 64) * 3.5) / 2),
              );
              const view = await index(signal, cutoff, budget, {
                work: preparationWork,
                readyOnly,
              });
              if (!view.complete) return defer();
              const messages: Message[] = system ? [system] : [];
              messages.push(
                {
                  role: "user",
                  content: `${view.text}\n\n<current-time>Backend clock (UTC): ${new Date().toISOString()}</current-time>`,
                  timestamp: now(),
                },
                ...current,
              );
              const after = durableContextBreakdown(messages).totalTokens;
              if (after >= limit) {
                if (readyOnly) return defer();
                throw new Error("Summarized context cannot fit the Cake Chat context limit.");
              }
              await root.commit(async (tx) => {
                const doc = await tx.doc(BoundaryDoc, root.id);
                const policy = await tx.doc(ContextPolicyDoc, root.id);
                delete policy.request;
                policy.lastSummary = {
                  beforeTokens: before.totalTokens,
                  afterTokens: after,
                  reason: reason ?? "cache-unknown",
                  completedAt: now(),
                };
                const reset = await tx.appendEntry(ResetEntry, root.id, {
                  head: "self",
                  model: messages,
                });
                if (system) await markSystemCarried(tx, root.id);
                doc.input = input;
                doc.marker = reset.id;
              }, context);
            } finally {
              activity = undefined;
              options.onChanged();
            }
          }
        };
        if (input !== undefined && (reason === "limit" || (newInput && reason))) {
          await reset(reason);
        } else if (newInput) {
          await root.commit(async (tx) => {
            (await tx.doc(BoundaryDoc, root.id)).input = input;
          }, context);
        }
        for (let attempt = 0; attempt < 2; attempt += 1) {
          signal.throwIfAborted();
          // Read the committed head even on recovery of a request whose old cutoff predates
          // the reset. Tool rounds and emergency compactions remain ordinary active context.
          active = await root.context(context);
          const requestedAt = now();
          const evidence = durableCacheEvidence(model.api);
          preparing = false;
          const source = options.models.streamSimple(
            model,
            {
              messages: active.messages.map((message) => withoutDurableInputPresentation(message)),
            },
            {
              ...streamOptions,
              maxTokens: reserve,
              onPayload: async (payload, selected) => {
                const resolved = (await streamOptions?.onPayload?.(payload, selected)) ?? payload;
                evidence.payload(resolved);
                return resolved;
              },
              onProviderStreamEvent: async (event, selected) => {
                evidence.event(event);
                await streamOptions?.onProviderStreamEvent?.(event, selected);
              },
            },
          );
          let recover = false;
          for await (const event of source) {
            if (
              event.type === "error" &&
              event.error.stopReason === "error" &&
              isContextOverflow(event.error) &&
              input !== undefined
            ) {
              const boundary = await harness.snapshot(BoundaryDoc, root.id, context);
              if (boundary?.overflowInput !== input) {
                // Persist the bound before doing any recovery work. Reopen cannot
                // repeat an overflowing reset indefinitely. SDK threshold/overflow
                // compaction stays disabled: this boundary is the sole owner.
                await root.commit(async (tx) => {
                  (await tx.doc(BoundaryDoc, root.id)).overflowInput = input;
                }, context);
                await reset("overflow");
                recover = true;
                break;
              }
            }
            if (event.type === "done") {
              await root.commit(async (tx) => {
                const policy = await tx.doc(ContextPolicyDoc, root.id);
                policy.request = {
                  provider: model.provider,
                  modelId: model.id,
                  api: model.api,
                  requestedAt,
                  inputTokens: event.message.usage.input,
                  cacheReadTokens: event.message.usage.cacheRead,
                  cacheWriteTokens: event.message.usage.cacheWrite,
                  ...evidence.snapshot(),
                  completedAt: now(),
                };
                if (
                  policy.request.cacheWrite1hTokens === undefined &&
                  event.message.usage.cacheWrite1h !== undefined
                )
                  policy.request.cacheWrite1hTokens = event.message.usage.cacheWrite1h;
                const estimate = anthropicCacheEstimate(
                  policy.request,
                  policy.requestHead === (active.head?.id ?? null) ? previousRequest : undefined,
                );
                if (estimate) policy.request.anthropicEstimate = estimate;
                if (streamOptions?.cacheRetention)
                  policy.request.retention = streamOptions.cacheRetention;
                policy.requestHead = active.head?.id ?? null;
                policy.requestSystem = durableSystemFingerprint(active.messages);
              }, context);
            }
            stream.push(event);
          }
          if (!recover) break;
        }
      })()
        .catch((error: unknown) => {
          const aborted = closing.signal.aborted || streamOptions?.signal?.aborted;
          // A failed/stopped preparation is not a new maintenance opportunity.
          // In particular its subsequently committed assistant error must not
          // immediately replay the same expensive work in the background.
          if (preparing) pendingCutoff = undefined;
          const failure = error instanceof DurableMemoryError ? error.reason : "preparation-failed";
          if (preparing && !aborted)
            options.onReport(
              new Error(
                `Cake Chat context preparation paused: ${failure}; ${JSON.stringify(preparationWork?.metrics())}.`,
              ),
            );
          const message = {
            role: "assistant" as const,
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            stopReason: aborted ? ("aborted" as const) : ("error" as const),
            // Durable classifies retryable provider failures by message text. Never
            // forward preparation/provider diagnostics (e.g. timeout/429) into that
            // classifier: only a new explicit submission may resume preparation.
            errorMessage:
              preparing && !aborted
                ? `Cake Chat context preparation failed (${failure}). Originals and committed memory progress are preserved. Submit again to continue; if the input cannot fit, shorten it or raise the Cake Chat context limit.`
                : error instanceof Error
                  ? error.message
                  : String(error),
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
        })
        .finally(() => {
          foreground -= 1;
          maintain();
        });
      return stream;
    },
  });
  // The SDK's single flag gates both threshold and overflow compaction. Cake's
  // provider boundary owns both limit resets and emergency recovery instead.
  // Preserve live settings getters without allowing a competing SDK owner.
  const settings: HarnessSettings = options.settings ?? { contextRetentionMs: 0 };
  const harnessSettings = new Proxy(settings, {
    get(target, key, receiver) {
      if (key === "compaction") return { ...target.compaction, enabled: false };
      return Reflect.get(target, key, receiver);
    },
  });
  const harness = await Harness.open(
    options.storage,
    {
      models,
      registry: options.registry,
      settings: harnessSettings,
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
    memory = createDurableChatMemory(harness, root, options.storage, {
      ...options.memory,
      onConsolidating: () => {
        if (activity) {
          activity = "consolidating";
          options.onChanged();
        }
      },
    });
    await root.commit(async (tx) => {
      await tx.doc(ChatMetadataDoc, root.id);
    }, BACKGROUND_CONTEXT);
    const unsubscribe = harness.subscribeCommits((publication) => {
      if (closing.signal.aborted) return;
      let visible = false;
      let originals = 0;
      let contextChanged = false;
      let liveChanged = false;
      for (const change of publication.changes) {
        // Side-chat forks commit through this Harness too; only Cake Chat's own
        // changes count toward its metadata, memory index and snapshots.
        if (changeConversation(change) !== root.id) continue;
        if (
          change.type === "entry" &&
          (change.value.model !== undefined ||
            change.value.head !== undefined ||
            change.value.edits !== undefined)
        )
          contextChanged = true;
        if (
          change.type === "entry" &&
          ["pi.user", "pi.assistant", "pi.tool-result"].includes(change.value.kind)
        ) {
          originals += 1;
          if (
            change.value.kind === "pi.assistant" &&
            change.value.model?.some(
              (message) =>
                message.role === "assistant" &&
                message.stopReason !== "error" &&
                message.stopReason !== "aborted" &&
                message.stopReason !== "toolUse",
            )
          )
            pendingCutoff = change.value.id;
        }
        if (change.type === "document" && change.record.kind === "pi.live") liveChanged = true;
        if (change.type === "entry" && !change.value.kind.startsWith("cake.chat-memory"))
          visible = true;
        if (
          change.type === "document" &&
          ["pi.live", "pi.inbox", "pi.agent", "pi.usage"].includes(change.record.kind)
        )
          visible = true;
      }
      if (contextChanged || originals > 0)
        queueMicrotask(() => {
          if (!closing.signal.aborted)
            void (async () => {
              // Read the SDK-owned active head, not the lifetime originals. This
              // never prepares a request, expands memory, or wakes the coordinator.
              const active = await root.context(BACKGROUND_CONTEXT);
              const contextMetadata = durableContextMetadata(active);
              await root.commit(async (tx) => {
                const metadata = await tx.doc(ChatMetadataDoc, root.id);
                metadata.messageCount += originals;
                if (originals > 0) metadata.modifiedAt = new Date().toISOString();
                metadata.contextMetadata = {
                  ...(metadata.contextMetadata?.lastModelActivityAt
                    ? { lastModelActivityAt: metadata.contextMetadata.lastModelActivityAt }
                    : null),
                  ...contextMetadata,
                };
              }, BACKGROUND_CONTEXT);
            })().catch(options.onReport);
        });
      if (visible) queueMicrotask(options.onChanged);
      if (originals > 0 || liveChanged) queueMicrotask(maintain);
    });
    // Reopen resumes the same persisted cursor, never replays indexed originals.
    pendingCutoff = (await root.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id;
    queueMicrotask(maintain);
    return {
      harness,
      root,
      memory,
      signal: closing.signal,
      storage: options.storage,
      index,
      async contextStatus(model: {
        provider: string;
        id: string;
        contextWindow: number;
        maxTokens?: number;
      }): Promise<CakeChatContextStatus> {
        const active = await root.context(BACKGROUND_CONTEXT);
        const boundary = await harness.snapshot(BoundaryDoc, root.id, BACKGROUND_CONTEXT);
        const policy = await Schema.decodeUnknownPromise(ContextPolicy)(
          (await harness.snapshot(ContextPolicyDoc, root.id, BACKGROUND_CONTEXT)) ?? {
            requestHead: null,
          },
        );
        const handoff =
          active.head?.id === boundary?.marker
            ? active.head?.model?.find((message) => message.role === "user")
            : undefined;
        const configuredLimitTokens = options.contextLimitTokens?.() ?? 300_000;
        const cache =
          policy?.requestHead === (active.head?.id ?? null) &&
          policy.requestSystem === durableSystemFingerprint(active.messages) &&
          policy?.request?.provider === model.provider &&
          policy.request.modelId === model.id
            ? policy.request
            : undefined;
        const status: CakeChatContextStatus = {
          ...durableContextBreakdown(active.messages, handoff),
          limitTokens: durableAdmission(model, configuredLimitTokens).limit,
          configuredLimitTokens,
          modelLimitTokens: model.contextWindow,
        };
        if (cache) Object.assign(status, { cache });
        if (activity) Object.assign(status, { activity });
        if (policy?.lastSummary) Object.assign(status, { lastSummary: policy.lastSummary });
        return status;
      },
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
        await maintenance;
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
