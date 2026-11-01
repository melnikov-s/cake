import { ASSISTANT_CONTEXT_ENTRY } from "./durable-assistant-context";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-durable-ai";
import {
  defineDoc,
  defineEntry,
  type Conversation,
  type Cursor,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import { Schema } from "effect";
import {
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-durable-ai/utils/transcript";
import { CompletionChat } from "../../contracts/pi/model-data";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import { MEMORY_COMPACTOR_PROMPT } from "./durable-memory-policy";
import { memoryBytes } from "../opt-memory/memory-policy";
import {
  MemoryNode,
  MemoryTreeState,
  MemoryRangeError,
  initialMemoryTreeState,
  createMemoryTree,
  type AnchoredNode,
  type StoredNode,
} from "../opt-memory/memory-tree";
import type { DurableChatMemoryView } from "./durable-chat-data";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";
import type { ContextInspection } from "../../contracts/conversations/context-inspection";
import { contextMessage } from "../pi/runtime/context-outline";
import { splitContextReminders } from "../pi/runtime/session-context-reminders";
import { withoutPassiveNotices } from "../../contracts/conversations/internal-input";
import { memoryWork, type MemoryWork } from "../opt-memory/memory-work";

import { durableSideChatImport, importedHistoryText } from "./durable-side-chat-history";

const StateDoc = defineDoc<MemoryTreeState>({
  kind: "cake.chat-memory-state",
  version: 3,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: initialMemoryTreeState,
  // Earlier indexes included tool traffic. Rebuild only the derived tree from
  // authoritative originals; never reuse old summaries or pending merge jobs.
  migrate: () => initialMemoryTreeState(),
});
// Immutable nodes use indexed entry reads, not document families: Durable retains loaded
// document trackers for its lifetime. Only StateDoc (bounded views/DAG + logarithmic forest) is live.
const NodeEntry = defineEntry<MemoryNode>("cake.chat-memory-node/v1");

// SAFETY: SDK ids are branded numbers; values here come from Durable or schema-validated persisted Id fields.
const entryId = (value: number) => value as EntryId;

export interface DurableMemoryOptions {
  readonly budget: () => number;
  readonly onConsolidating?: () => void;
  /** A node's summary kept failing, so it stores a verbatim excerpt instead. */
  readonly onExcerpt?: (line: { id: number; n: number }) => void;
  readonly summarize: (input: {
    instructions: string;
    context: string;
    signal: AbortSignal;
    previous?: readonly { role: "user" | "assistant"; text: string }[];
    tools?: CompletionChat["tools"];
  }) => Promise<string>;
}

function durableMessageText(message: Message): string {
  if (message.role === "system" || message.role === "toolResult") return "";
  if (message.role === "assistant")
    return message.content
      .flatMap((block) =>
        block.type === "text" && block.text.trim() ? [`talk: ${block.text}`] : [],
      )
      .join("\n"); // Tool calls, reasoning and error metadata stay in originals, not memory.
  const rawText = Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text" ? block.text : "[image attached; zoom for the original]",
        )
        .join("\n")
    : message.content;
  const input = message.role === "user" ? durableInputPresentation(rawText) : undefined;
  if (input?.internal?._tag === "AgentUpdate")
    return `work: [${input.internal.update.source.title}] ${input.internal.update.text}`;
  if (input?.internal?._tag === "UserWithReminders" && input.internal.userText !== undefined) {
    const work = [
      ...[...(input.internal.reportNotices ?? []), ...input.internal.notices].map(
        (notice) => `work: [${notice.crossSession.sender.title}] ${notice.text}`,
      ),
      ...(input.internal.updates ?? []).map(
        (update) => `work: [${update.source.title}] ${update.text}`,
      ),
    ];
    return [...work, `user: ${input.internal.userText}`].join("\n");
  }
  const text =
    input?.internal?._tag === "UserWithReminders"
      ? input.internal.text
      : input?.internal?._tag === "UpdateBatch"
        ? withoutPassiveNotices(input.body, input.internal)
        : (input?.body ?? rawText);
  if (input?.subagentReport)
    return `work: received worker report ${JSON.stringify(input.subagentReport)}; receipt does not establish user-facing communication: ${text}`;
  // A schedule the agent or user set earlier fired; it is not something the user just said.
  const scheduled = parseScheduledMessage(text);
  if (scheduled)
    return `work: scheduled message fired (set ${scheduled.origin.createdAt}): ${scheduled.text}`;
  const context = splitContextReminders(text);
  if (context.reminders.length) {
    const work = context.reminders
      .filter(
        (item) =>
          item.title === "Cake · reference notifications" ||
          item.title === "Cake · session updates",
      )
      .map((item) =>
        item.title === "Cake · reference notifications"
          ? `work: received workflow context; user-facing handling not established by intake (current obligations live in sessions.reports): ${item.text}`
          : `work: received session updates; receipt is not communication (decisions live in sessions.completions): ${item.text}`,
      );
    return [...work, ...(context.text ? [`user: ${context.text}`] : [])].join("\n");
  }
  const report = parseCrossSessionMessage(text);
  if (report) return `work: [${report.metadata.sender.title}] ${report.text}`;
  if (/^Background subagent\b/.test(text)) return `work: ${text}`;
  return `user: ${text}`;
}
const sourceText = (entry: EntryRecord) => {
  const imported = durableSideChatImport(entry);
  if (imported) return importedHistoryText(imported);
  // Only originals enter the tree. Reset handoffs, system declarations, emergency
  // compaction summaries and our derived nodes must never be summarized a second time.
  if (entry.kind === ASSISTANT_CONTEXT_ENTRY)
    return (
      "work: " + Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String }))(entry.data).text
    );
  if (!["pi.user", "pi.assistant"].includes(entry.kind)) return "";
  return entry.model?.map(durableMessageText).filter(Boolean).join("\n") ?? "";
};
const line = (node: AnchoredNode) =>
  `${node.id}+${node.n}|[originals=${node.fromEntryId}..${node.throughEntryId}] ${node.text.replace(/\s*\n\s*/g, " ")}`;
const render = (nodes: readonly AnchoredNode[]) => `<chat>\n${nodes.map(line).join("\n")}\n</chat>`;
/** One serialized caller owns indexing. No lifetime transcript or node cache is retained. */
export function createDurableChatMemory(
  harness: Harness,
  root: Conversation,
  storage: Storage,
  options: DurableMemoryOptions,
) {
  const contextFor = (signal: AbortSignal) => withAbortSignal(signal, BACKGROUND_CONTEXT);
  const state = async (signal: AbortSignal) =>
    structuredClone(
      await Schema.decodeUnknownPromise(MemoryTreeState)(
        (await harness.snapshot(StateDoc, root.id, contextFor(signal))) ?? initialMemoryTreeState(),
      ),
    );
  const node = async (ref: number, signal: AbortSignal): Promise<StoredNode> => {
    const entry = (await storage.entry(root.id, entryId(ref), contextFor(signal)))?.entry;
    if (!NodeEntry.is(entry)) throw new Error(`Missing Cake Chat summary entry ${ref}`);
    return { ...(await Schema.decodeUnknownPromise(MemoryNode)(entry.data)), entry: entry.id };
  };
  const tree = createMemoryTree(
    {
      state,
      node,
      save: (value, signal) =>
        root.commit(async (tx) => {
          const doc = await tx.doc(StateDoc, root.id);
          Object.assign(doc, value);
          if (!value.pending) delete doc.pending;
        }, contextFor(signal)),
      append: async (value, current, assigned, signal) => {
        await root.commit(async (tx) => {
          const stored = await tx.appendEntry(NodeEntry, root.id, { data: value });
          assigned(stored.id);
          Object.assign(await tx.doc(StateDoc, root.id), current);
        }, contextFor(signal));
      },
      original: async (ref, signal) => {
        const original = (await storage.entry(root.id, entryId(ref), contextFor(signal)))?.entry;
        if (!original) throw new Error("Cake Chat original is missing");
        return sourceText(original);
      },
      context: async (signal) => {
        const active = await root.context(contextFor(signal));
        return {
          instructions: getCurrentSystemPrompt(active.messages) || MEMORY_COMPACTOR_PROMPT,
          tools: (
            await Schema.decodeUnknownPromise(CompletionChat)({
              tools: getCurrentTools(active.messages),
              previous: [],
            })
          ).tools,
        };
      },
      render,
    },
    { ...options, compactionPolicy: MEMORY_COMPACTOR_PROMPT },
  );
  const { anchored, save, fitViews, plan, build, lookupIndexed } = tree;

  const synchronize = async (
    signal: AbortSignal,
    cutoff?: EntryId,
    budget = options.budget(),
    batch: { maxOriginals?: number; readyOnly?: boolean; work?: MemoryWork } = {},
  ): Promise<DurableChatMemoryView & { complete: boolean }> => {
    const work = batch.work ?? memoryWork(signal);
    signal = work.signal;
    const current = await state(signal);
    // Advisory cache refresh may only consume a complete persisted index. Never
    // wait on a pending DAG (including a serial merge chain) or launch providers.
    const incomplete = () => ({
      text: "",
      complete: false,
      bytes: 0,
      sourceCount: current.count,
      partCount: current.parts.length,
    });
    let processed = 0;
    if (current.pending) {
      if (batch.readyOnly) return incomplete();
      processed += current.pending.jobs.filter(
        (job) => job.n === 1 && job.id >= current.count,
      ).length;
      await build(current, work, budget);
    }
    const newest =
      cutoff ?? (await root.entries({}, 1, undefined, contextFor(signal))).items[0]?.id;
    let complete = true;
    if (newest !== undefined) {
      let cursor: Cursor | undefined;
      const query: Omit<EntryQuery, "conversationId"> = { order: "ascending", maxEntryId: newest };
      if (current.through !== null)
        Object.assign(query, { minEntryId: entryId(current.through + 1) });
      scan: do {
        const page = await root.entries(query, 64, cursor, contextFor(signal));
        const originals: EntryRecord[] = [];
        let skipped: number | undefined;
        for (const original of page.items) {
          signal.throwIfAborted();
          if (sourceText(original)) {
            if (batch.readyOnly) return incomplete();
            if (processed + originals.length >= (batch.maxOriginals ?? Infinity)) {
              if (originals.length) {
                await plan(current, originals, signal);
                await build(current, work, budget);
              }
              complete = false;
              break scan;
            }
            originals.push(original);
          } else skipped = original.id;
        }
        if (originals.length) {
          await plan(current, originals, signal);
          await build(current, work, budget);
          processed += originals.length;
        }
        if (skipped !== undefined) current.through = Math.max(current.through ?? -1, skipped);
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const text = await fitViews(current, signal, budget);
    await save(current, signal);
    if (memoryBytes(text) > current.budget) {
      if (batch.readyOnly) return incomplete();
      throw new Error("Cake Chat history cannot fit its memory budget");
    }
    return {
      text,
      complete,
      bytes: memoryBytes(text),
      sourceCount: current.count,
      partCount: current.parts.length,
    };
  };

  const lookup = async (id: number, n: number, signal: AbortSignal) => {
    const found = await lookupIndexed(id, n, signal).catch((error: unknown) => {
      if (!(error instanceof MemoryRangeError)) throw error;
      throw new Error(
        error.reason === "invalid-range"
          ? `No memory line ${id}+${n}. Use an existing id+n from <chat> or Zoom children: id is a nonnegative integer, n is a power of two (1, 2, 4, ...), id must be divisible by n, and the range must be indexed. For an unavailable range, use archive_search with the old line's [originals=A..B] bounds or a specific query, then archive_read.`
          : `Memory line ${id}+${n} is not ready. Use another current <chat> range, or archive_search with its [originals=A..B] bounds, then archive_read.`,
      );
    });
    const { head } = await root.context(contextFor(signal));
    // Rebuilding renumbers ranges without rewriting the live head. A line from
    // that head must never silently resolve to a newly indexed, different source.
    if (
      head &&
      found.entry > head.id &&
      head.model?.some(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("<chat>\n"),
      )
    )
      throw new Error(
        "The memory index was rebuilt; this id+n handle is stale and may now identify different history. Do not retry these coordinates. Use archive_search with [originals=A..B] from the old memory line (fromEntryId=A, throughEntryId=B), or a specific query if it has no bounds, then archive_read. Fresh Zoom handles arrive in <chat> at the next memory handoff; only then use those refreshed ranges.",
      );
    return found;
  };

  const zoom = async (
    id: number,
    n: number,
    signal: AbortSignal,
    page: { offset?: number; maxChars?: number } = {},
  ) => {
    const offset = page.offset ?? 0;
    const maxChars = page.maxChars ?? 8_000;
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("offset must be a nonnegative UTF-16 character offset; start at 0");
    if (!Number.isSafeInteger(maxChars) || maxChars < 1 || maxChars > 8_000)
      throw new Error("maxChars must be an integer from 1 to 8000");
    if (n !== 1 && (page.offset !== undefined || page.maxChars !== undefined))
      throw new Error("offset and maxChars page originals only; expand to n=1 first");
    const found = await lookup(id, n, signal);
    if (found.n === 1) {
      if (found.original === undefined) throw new Error("Cake Chat summary has no original");
      const original = (await storage.entry(root.id, entryId(found.original), contextFor(signal)))
        ?.entry;
      if (!original) throw new Error("Cake Chat original is missing");
      const text = `${id}+0|[originals=${found.original}..${found.original}] ${sourceText(original)}`;
      if (offset > text.length)
        throw new Error(
          `offset exceeds this original's ${text.length} UTF-16 characters; start at 0 or follow nextOffset`,
        );
      const slice = text.slice(offset, offset + maxChars);
      return {
        text: slice,
        messages: original.model ?? [],
        page: {
          id,
          n: 1,
          entryId: found.original,
          offset,
          totalChars: text.length,
          nextOffset: offset + slice.length < text.length ? offset + slice.length : null,
        },
      };
    }
    const children = await Promise.all(found.children!.map((ref) => node(ref, signal)));
    return {
      text: (await Promise.all(children.map((child) => anchored(child, signal))))
        .map(line)
        .join("\n"),
      messages: [],
    };
  };
  const inspect = async (
    id: number,
    n: number,
    signal: AbortSignal,
  ): Promise<ContextInspection> => {
    const found = await lookup(id, n, signal);
    if (found.children) {
      const children = await Promise.all(found.children.map((ref) => node(ref, signal)));
      return {
        sources: children.map((child) => ({
          id: `memory-${child.id}+${child.n}`,
          title: child.text,
          kind: "summary",
          summaryDepth: 1 + Math.log2(child.n),
          source: `Pi Durable summary ${child.id}+${child.n}`,
          detail: { memoryId: child.id, memoryCount: child.n },
        })),
      };
    }
    if (found.original === undefined) throw new Error("Cake Chat summary has no original");
    const original = (await storage.entry(root.id, entryId(found.original), contextFor(signal)))
      ?.entry;
    if (!original) throw new Error("Cake Chat original is missing");
    return {
      sources: (original.model ?? []).map((message, index) => ({
        ...contextMessage(
          `original-${original.id}-${index}`,
          message.role,
          withoutDurableInputPresentation(message).content,
        ),
        source: `Pi Durable entry ${original.id}`,
      })),
    };
  };
  return { synchronize, zoom, inspect };
}
