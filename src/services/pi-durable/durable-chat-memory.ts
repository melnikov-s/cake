import {
  awaitWithContext,
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
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
import {
  MEMORY_COMPACTOR_PROMPT,
  MEMORY_INPUT_BYTES,
  MEMORY_NODE_BYTES,
  MEMORY_SUMMARY_FAILURES,
  memoryBytes,
  utf8Slice,
} from "./durable-memory-policy";
import type { DurableChatMemoryView } from "./durable-chat-data";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";
import type { ContextInspection } from "../../contracts/conversations/context-inspection";
import { contextMessage } from "../pi/runtime/context-outline";
import { splitContextReminders } from "../pi/runtime/session-context-reminders";
import { withoutPassiveNotices } from "../../contracts/conversations/internal-input";
import {
  DurableMemoryError,
  durableMemoryWork,
  type DurableMemoryWork,
} from "./durable-memory-work";

import { durableSideChatImport, importedHistoryText } from "./durable-side-chat-history";

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Range = Schema.Struct({ id: Id, n: Schema.Int.check(Schema.isGreaterThan(0)), entry: Id });
const Node = Schema.Struct({
  id: Range.fields.id,
  n: Range.fields.n,
  text: Schema.NonEmptyString,
  original: Schema.optionalKey(Id),
  children: Schema.optionalKey(Schema.mutable(Schema.Tuple([Id, Id]))),
});
type Node = Schema.Schema.Type<typeof Node>;
type StoredNode = Node & { readonly entry: number };
const Part = Schema.Struct({ ...Range.fields, ancestors: Schema.mutable(Schema.Array(Id)) });
type Part = Schema.Schema.Type<typeof Part>;
const Link = Schema.Union([Schema.Struct({ entry: Id }), Schema.Struct({ job: Id })]);
const Job = Schema.Struct({
  id: Id,
  n: Schema.Int.check(Schema.isGreaterThan(0)),
  original: Schema.optionalKey(Id),
  left: Schema.optionalKey(Link),
  right: Schema.optionalKey(Link),
  entry: Schema.mutableKey(Schema.optionalKey(Id)),
});
const Reference = Schema.Struct({
  parts: Schema.mutableKey(Schema.mutable(Schema.Array(Part))),
  shrinking: Schema.mutableKey(Schema.Boolean),
});
const Pending = Schema.Struct({
  jobs: Schema.mutable(Schema.Array(Job)),
  forest: Schema.mutable(Schema.Array(Schema.Struct({ id: Id, n: Schema.Int, link: Link }))),
});
const State = Schema.Struct({
  through: Schema.mutableKey(Schema.NullOr(Id)),
  count: Schema.mutableKey(Id),
  budget: Schema.mutableKey(Id),
  shrinking: Schema.mutableKey(Schema.Boolean),
  forest: Schema.mutableKey(Schema.mutable(Schema.Array(Range))),
  parts: Schema.mutableKey(Schema.mutable(Schema.Array(Part))),
  reference: Schema.mutableKey(Schema.optionalKey(Reference)),
  pending: Schema.mutableKey(Schema.optionalKey(Pending)),
});
type State = Schema.Schema.Type<typeof State>;
const initial = (): State => ({
  through: null,
  count: 0,
  budget: 0,
  shrinking: false,
  forest: [],
  parts: [],
});
const StateDoc = defineDoc<State>({
  kind: "cake.chat-memory-state",
  version: 3,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial,
  // Earlier indexes included tool traffic. Rebuild only the derived tree from
  // authoritative originals; never reuse old summaries or pending merge jobs.
  migrate: () => initial(),
});
// Immutable nodes use indexed entry reads, not document families: Durable retains loaded
// document trackers for its lifetime. Only StateDoc (bounded views/DAG + logarithmic forest) is live.
const NodeEntry = defineEntry<Node>("cake.chat-memory-node/v1");

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
  if (!["pi.user", "pi.assistant"].includes(entry.kind)) return "";
  return entry.model?.map(durableMessageText).filter(Boolean).join("\n") ?? "";
};
type SourceRange = { readonly fromEntryId: number; readonly throughEntryId: number };
type AnchoredNode = StoredNode & SourceRange;
const line = (node: AnchoredNode) =>
  `${node.id}+${node.n}|[originals=${node.fromEntryId}..${node.throughEntryId}] ${node.text.replace(/\s*\n\s*/g, " ")}`;
const render = (nodes: readonly AnchoredNode[]) => `<chat>\n${nodes.map(line).join("\n")}\n</chat>`;
/** Bound one request's <input>: head and tail of an oversized original, never a model overflow. */
const boundedInput = (text: string) => {
  const bytes = memoryBytes(text);
  if (bytes <= MEMORY_INPUT_BYTES) return text;
  const half = Math.floor(MEMORY_INPUT_BYTES / 2);
  const head = utf8Slice(text, half);
  const tail = utf8Slice(text, half, "end");
  return `${head}\n[… ${bytes - memoryBytes(head) - memoryBytes(tail)} bytes omitted; zoom for the original …]\n${tail}`;
};
const EXCERPT = "[excerpt; summary unavailable] ";
const EXCERPT_JOIN = " … ";
/** Deterministic fallback when the summarizer keeps failing: verbatim text from every
 * source (both children of a merge), bounded to one memory line. */
const excerpt = (sources: readonly string[]) => {
  const room =
    MEMORY_NODE_BYTES - memoryBytes(EXCERPT) - memoryBytes(EXCERPT_JOIN) * (sources.length - 1);
  const each = Math.floor(room / sources.length);
  return `${EXCERPT}${sources.map((source) => utf8Slice(source.replace(/\s+/g, " ").trim(), each)).join(EXCERPT_JOIN)}`;
};

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
      await Schema.decodeUnknownPromise(State)(
        (await harness.snapshot(StateDoc, root.id, contextFor(signal))) ?? initial(),
      ),
    );
  const node = async (ref: number, signal: AbortSignal): Promise<StoredNode> => {
    const entry = (await storage.entry(root.id, entryId(ref), contextFor(signal)))?.entry;
    if (!NodeEntry.is(entry)) throw new Error(`Missing Cake Chat summary entry ${ref}`);
    return { ...(await Schema.decodeUnknownPromise(Node)(entry.data)), entry: entry.id };
  };
  // Follow only the two boundary paths, never scan a summary's entire subtree.
  // Existing immutable nodes already carry all provenance; no index migration or
  // lifetime cache is needed to recover bounds after restart.
  const sourceRange = async (found: StoredNode, signal: AbortSignal): Promise<SourceRange> => {
    const boundary = async (side: 0 | 1) => {
      let edge = found;
      while (edge.children) edge = await node(edge.children[side], signal);
      if (edge.original === undefined) throw new Error("Cake Chat summary has no original");
      return edge.original;
    };
    if (found.original !== undefined)
      return { fromEntryId: found.original, throughEntryId: found.original };
    const [fromEntryId, throughEntryId] = await Promise.all([boundary(0), boundary(1)]);
    return { fromEntryId, throughEntryId };
  };
  const anchored = async (found: StoredNode, signal: AbortSignal): Promise<AnchoredNode> => ({
    ...found,
    ...(await sourceRange(found, signal)),
  });
  const nodes = async (parts: readonly Part[], signal: AbortSignal) => {
    const result: AnchoredNode[] = [];
    for (const part of parts) result.push(await anchored(await node(part.entry, signal), signal));
    return result;
  };
  const save = (value: State, signal: AbortSignal) =>
    root.commit(async (tx) => {
      const doc = await tx.doc(StateDoc, root.id);
      Object.assign(doc, value);
      if (!value.pending) delete doc.pending;
    }, contextFor(signal));

  const summarize = async (
    sources: readonly string[],
    prefix: string,
    task: { id: number; n: number },
    work: DurableMemoryWork,
    shared: { instructions: string; tools: CompletionChat["tools"] },
  ) => {
    work.signal.throwIfAborted();
    const text = sources.join("\n");
    if (memoryBytes(text) <= MEMORY_NODE_BYTES) return text;
    const request =
      task.n === 1
        ? `Compaction: compress message ${task.id} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${"-".repeat(512)}`
        : `Compaction: merge lines ${task.id}+${task.n / 2} and ${task.id + task.n / 2}+${task.n / 2}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${"-".repeat(512)}\n<chat> may hold their messages, ${task.id} to ${task.id + task.n - 1}, in more detail: take details\nof them from there too.`;
    // Persisted active heads can predate the shared compaction section. Preserve
    // their exact system/cache prefix, but never drop compaction's data/provenance
    // safeguards while waiting for the next ordinary request to update that head.
    const policy = shared.instructions.includes(MEMORY_COMPACTOR_PROMPT)
      ? ""
      : `\n${MEMORY_COMPACTOR_PROMPT}`;
    const context = `${prefix}\n\n${request}${policy}\n<input>\n${boundedInput(text)}\n</input>`;
    const previous: { role: "user" | "assistant"; text: string }[] = [];
    let shortest: string | undefined;
    let failures = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let answer: string;
      try {
        answer = (
          await work.complete((signal) =>
            options.summarize({
              instructions: shared.instructions,
              tools: shared.tools,
              context,
              previous: [...previous],
              signal,
            }),
          )
        ).trim();
        if (!answer) throw new DurableMemoryError({ reason: "empty-summary" });
      } catch (error) {
        // Cancellation propagates. A failed answer (provider error, tool call,
        // oversized or empty output) is retried, then replaced by an excerpt.
        if (!(error instanceof DurableMemoryError)) throw error;
        failures += 1;
        if (failures < MEMORY_SUMMARY_FAILURES) continue;
        break;
      }
      if (shortest === undefined || memoryBytes(answer) < memoryBytes(shortest)) shortest = answer;
      if (memoryBytes(answer) <= MEMORY_NODE_BYTES) return answer;
      // A UTF-8-safe byte cut is a ruler in feedback, never a stored summary.
      const cut = utf8Slice(answer, MEMORY_NODE_BYTES);
      previous.push(
        { role: "assistant", text: answer },
        {
          role: "user",
          text: `Too long: your line is ${memoryBytes(answer)} bytes, over the 512-byte limit. Write the whole line again for the same <input>, cutting just enough of the least valuable items to fit before this cut:\n${cut}| ← LIMIT`,
        },
      );
    }
    // Public chat-memory spec: five attempts, retain the shortest, measure real
    // view bytes. It explicitly tolerates slight oversize, not arbitrary truncation.
    if (shortest !== undefined) return shortest;
    options.onExcerpt?.(task);
    return excerpt(sources);
  };

  const fit = async (current: State, signal: AbortSignal, budget: number) => {
    Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))(budget);
    current.budget = budget;
    const visible = await nodes(current.parts, signal);
    if (memoryBytes(render(visible)) > budget) current.shrinking = true;
    if (current.shrinking) {
      options.onConsolidating?.();
      const target = Math.floor(budget / 2);
      while (memoryBytes(render(visible)) > target && visible.length > 1) {
        let best = -1;
        let priority = -Infinity;
        for (let i = 0; i + 1 < visible.length; i += 1) {
          const a = current.parts[i]!;
          const b = current.parts[i + 1]!;
          if (
            a.n !== b.n ||
            a.id % (2 * a.n) !== 0 ||
            b.id !== a.id + a.n ||
            a.ancestors[0] === undefined ||
            a.ancestors[0] !== b.ancestors[0]
          )
            continue;
          const due = (current.count - (b.id + b.n - 1)) / a.n;
          if (due > priority) {
            priority = due;
            best = i;
          }
        }
        if (best < 0) break;
        const part = current.parts[best]!;
        const parent = await node(part.ancestors[0]!, signal);
        current.parts.splice(best, 2, {
          id: parent.id,
          n: parent.n,
          entry: parent.entry,
          ancestors: part.ancestors.slice(1),
        });
        visible.splice(best, 2, {
          ...parent,
          fromEntryId: visible[best]!.fromEntryId,
          throughEntryId: visible[best + 1]!.throughEntryId,
        });
      }
      current.shrinking = memoryBytes(render(visible)) > target;
    }
    return render(visible);
  };

  const fitViews = async (current: State, signal: AbortSignal, budget: number) => {
    const before = current.parts.length;
    const text = await fit(current, signal, budget);
    if (current.reference) {
      if (current.parts.length < before) {
        current.reference.parts = structuredClone(current.parts);
        current.reference.shrinking = true;
      }
      const refState = {
        ...current,
        parts: current.reference.parts,
        shrinking: current.reference.shrinking,
      };
      await fit(refState, signal, 32_000);
      current.reference.parts = refState.parts;
      current.reference.shrinking = refState.shrinking;
    }
    return text;
  };

  // A bounded persisted source window gives deterministic IDs without retaining
  // lifetime history. Each source is scanned once; every successful node commits
  // independently. Recovery resumes the same DAG, not a leaf's entire carry chain.
  const plan = async (current: State, originals: readonly EntryRecord[], signal: AbortSignal) => {
    const jobs: Schema.Schema.Type<typeof Pending>["jobs"] = [];
    const forest: Schema.Schema.Type<typeof Pending>["forest"] = current.forest.map((range) => ({
      id: range.id,
      n: range.n,
      link: { entry: range.entry },
    }));
    for (const [offset, original] of originals.entries()) {
      const leaf = { id: current.count + offset, n: 1, original: original.id };
      jobs.push(leaf);
      let right: Schema.Schema.Type<typeof Pending>["forest"][number] = {
        id: leaf.id,
        n: 1,
        link: { job: jobs.length - 1 },
      };
      while (forest.at(-1)?.n === right.n) {
        const left = forest.pop()!;
        jobs.push({ id: left.id, n: left.n * 2, left: left.link, right: right.link });
        right = { id: left.id, n: left.n * 2, link: { job: jobs.length - 1 } };
      }
      forest.push(right);
    }
    current.pending = { jobs, forest };
    await save(current, signal);
  };

  const build = async (current: State, work: DurableMemoryWork, budget: number) => {
    const pending = current.pending!;
    const stopped = new AbortController();
    const signal = AbortSignal.any([work.signal, stopped.signal]);
    const jobs = pending.jobs;
    const activeContext = await root.context(contextFor(signal));
    const shared = {
      instructions: getCurrentSystemPrompt(activeContext.messages) || MEMORY_COMPACTOR_PROMPT,
      tools: (
        await Schema.decodeUnknownPromise(CompletionChat)({
          tools: getCurrentTools(activeContext.messages),
          previous: [],
        })
      ).tools,
    };
    const leaves = jobs.map((job, index) => ({ job, index })).filter(({ job }) => job.n === 1);
    const dependents = new Map<number, number[]>();
    const waiting = new Map<number, number>();
    const ready: number[] = [];
    let nextLeaf = 0;
    let unbuiltBefore = 0;
    const done = (link: Schema.Schema.Type<typeof Link>) =>
      "entry" in link || jobs[link.job]!.entry !== undefined;
    const resolve = (link: Schema.Schema.Type<typeof Link>) =>
      "entry" in link ? link.entry : jobs[link.job]!.entry!;
    for (const [index, job] of jobs.entries()) {
      if (job.entry !== undefined || job.n === 1) continue;
      let count = 0;
      for (const link of [job.left!, job.right!]) {
        if (!done(link) && "job" in link) {
          count += 1;
          const list = dependents.get(link.job) ?? [];
          list.push(index);
          dependents.set(link.job, list);
        }
      }
      waiting.set(index, count);
      if (count === 0) ready.push(index);
    }
    const releaseLeaves = () => {
      while (nextLeaf < leaves.length && unbuiltBefore < 8) {
        const { job, index } = leaves[nextLeaf++]!;
        if (job.entry !== undefined) continue;
        unbuiltBefore += 1;
        ready.push(index);
      }
    };
    const inherit = (parts: Part[], job: Schema.Schema.Type<typeof Job>) => {
      if (job.n === 1 || job.entry === undefined) return;
      for (const part of parts) {
        if (
          job.n > part.n &&
          part.id >= job.id &&
          part.id + part.n <= job.id + job.n &&
          !part.ancestors.includes(job.entry)
        )
          part.ancestors.push(job.entry);
      }
    };
    const updateViews = async () => {
      if (!current.reference)
        current.reference = { parts: structuredClone(current.parts), shrinking: true };
      for (const { job } of leaves) {
        if (job.id < current.count) continue;
        if (job.id !== current.count || job.entry === undefined) break;
        const part = { id: job.id, n: 1, entry: job.entry, ancestors: [] };
        current.parts.push(structuredClone(part));
        current.reference.parts.push(structuredClone(part));
        current.count += 1;
        current.through = job.original!;
      }
      for (const job of jobs) {
        inherit(current.parts, job);
        inherit(current.reference.parts, job);
      }
      await fitViews(current, signal, budget);
    };
    const prefix = async (job: Schema.Schema.Type<typeof Job>) => {
      const end = job.id + (job.n === 1 ? 0 : job.n);
      // count is the built leaf prefix. The reference view contains no future
      // lines or placeholders, even if a later independent leaf finished first.
      const visible: Part[] = [];
      const include = async (found: StoredNode, ancestors: number[]): Promise<void> => {
        if (found.id >= end) return;
        if (found.id + found.n <= end)
          visible.push({ id: found.id, n: found.n, entry: found.entry, ancestors });
        else if (found.children) {
          const parents = [found.entry, ...ancestors];
          await include(await node(found.children[0], signal), parents);
          await include(await node(found.children[1], signal), parents);
        }
      };
      for (const part of current.reference?.parts ?? current.parts)
        await include(await node(part.entry, signal), part.ancestors);
      // Splitting the one line crossing the task boundary can add bytes. Bound
      // that request's built prefix with the same merge policy, never a text cut.
      return fit(
        { ...current, count: Math.min(current.count, end), parts: visible, shrinking: false },
        signal,
        32_000,
      );
    };
    type Completion = { index: number; text: string } | { index: number; error: unknown };
    const active = new Map<number, Promise<Completion>>();
    const launch = (index: number) => {
      const job = jobs[index]!;
      const task = (async () => {
        const context = await prefix(job);
        const sources =
          job.n === 1
            ? [
                sourceText(
                  (await storage.entry(root.id, entryId(job.original!), contextFor(signal)))!.entry,
                ),
              ]
            : [
                (await node(resolve(job.left!), signal)).text,
                (await node(resolve(job.right!), signal)).text,
              ];
        return summarize(
          sources,
          context,
          job,
          {
            ...work,
            signal,
            complete: (operation) =>
              work.complete((callSignal) => operation(AbortSignal.any([callSignal, signal]))),
          },
          shared,
        );
      })();
      active.set(
        index,
        awaitWithContext(task, contextFor(signal)).then(
          (text) => ({ index, text }),
          (error: unknown) => ({ index, error }),
        ),
      );
    };
    try {
      await updateViews();
      releaseLeaves();
      while (ready.length || active.size) {
        signal.throwIfAborted();
        while (ready.length && active.size < 8) launch(ready.shift()!);
        if (!active.size) break;
        const result = await Promise.race(active.values());
        active.delete(result.index);
        if ("error" in result) throw result.error;
        signal.throwIfAborted();
        const job = jobs[result.index]!;
        await root.commit(async (tx) => {
          const stored = await tx.appendEntry(NodeEntry, root.id, {
            data: {
              id: job.id,
              n: job.n,
              text: result.text,
              ...(job.n === 1
                ? { original: job.original! }
                : { children: [resolve(job.left!), resolve(job.right!)] }),
            },
          });
          job.entry = stored.id;
          Object.assign(await tx.doc(StateDoc, root.id), current);
        }, contextFor(signal));
        if (job.n === 1) unbuiltBefore -= 1;
        for (const parent of dependents.get(result.index) ?? []) {
          const count = waiting.get(parent)! - 1;
          waiting.set(parent, count);
          if (count === 0) ready.push(parent);
        }
        await updateViews();
        await save(current, signal);
        releaseLeaves();
      }
      current.forest = pending.forest.map((range) => ({
        id: range.id,
        n: range.n,
        entry: resolve(range.link),
      }));
      delete current.pending;
      await save(current, signal);
    } finally {
      stopped.abort();
      // Drain wrappers before releasing the serialized persistence owner. A
      // cancellation-ignoring provider can never publish a late node.
      await Promise.all(active.values());
    }
  };

  const synchronize = async (
    signal: AbortSignal,
    cutoff?: EntryId,
    budget = options.budget(),
    batch: { maxOriginals?: number; readyOnly?: boolean; work?: DurableMemoryWork } = {},
  ): Promise<DurableChatMemoryView & { complete: boolean }> => {
    const work = batch.work ?? durableMemoryWork(signal);
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

  const lookupIndexed = async (id: number, n: number, signal: AbortSignal) => {
    const current = await state(signal);
    if (
      !Number.isSafeInteger(id) ||
      id < 0 ||
      !Number.isSafeInteger(n) ||
      n < 1 ||
      !Number.isInteger(Math.log2(n)) ||
      id % n !== 0 ||
      id + n > current.count
    )
      throw new Error(
        `No memory line ${id}+${n}. Use an existing id+n from <chat> or Zoom children: id is a nonnegative integer, n is a power of two (1, 2, 4, ...), id must be divisible by n, and the range must be indexed. For an unavailable range, use archive_search with the old line's [originals=A..B] bounds or a specific query, then archive_read.`,
      );
    const pending = current.pending?.jobs.find(
      (job) => job.id === id && job.n === n && job.entry !== undefined,
    );
    if (pending?.entry !== undefined) return node(pending.entry, signal);
    const rootRef = current.forest.find((range) => range.id <= id && range.id + range.n >= id + n);
    if (!rootRef)
      throw new Error(
        `Memory line ${id}+${n} is not ready. Use another current <chat> range, or archive_search with its [originals=A..B] bounds, then archive_read.`,
      );
    let found = await node(rootRef.entry, signal);
    while (found.n > n) {
      if (!found.children) throw new Error("Cake Chat summary has no children");
      found = await node(found.children[id < found.id + found.n / 2 ? 0 : 1], signal);
    }
    return found;
  };

  const lookup = async (id: number, n: number, signal: AbortSignal) => {
    const found = await lookupIndexed(id, n, signal);
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
