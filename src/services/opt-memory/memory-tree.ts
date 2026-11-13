import { Schema, Struct } from "effect";
import type { CompletionChat } from "../../contracts/pi/model-data";
import { MEMORY_INPUT_BYTES, MEMORY_NODE_BYTES, memoryBytes, utf8Slice } from "./memory-policy";
import {
  abortableMemoryTask,
  MemoryFailureReason,
  MemorySummaryError,
  type MemoryWork,
} from "./memory-work";

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Range = Schema.Struct({ id: Id, n: Schema.Int.check(Schema.isGreaterThan(0)), entry: Id });
export const MemoryDegradation = Schema.Struct({
  reason: MemoryFailureReason,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  model: Schema.optionalKey(Schema.String),
});
export type MemoryDegradation = Schema.Schema.Type<typeof MemoryDegradation>;
export const MemoryNode = Schema.Struct({
  id: Range.fields.id,
  n: Range.fields.n,
  text: Schema.NonEmptyString,
  degraded: Schema.optionalKey(MemoryDegradation),
  original: Schema.optionalKey(Id),
  children: Schema.optionalKey(Schema.mutable(Schema.Tuple([Id, Id]))),
});
export type MemoryNode = Schema.Schema.Type<typeof MemoryNode>;
export type StoredNode = MemoryNode & { readonly entry: number };
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
export const MemoryTreeState = Schema.Struct({
  through: Schema.mutableKey(Schema.NullOr(Id)),
  count: Schema.mutableKey(Id),
  budget: Schema.mutableKey(Id),
  shrinking: Schema.mutableKey(Schema.Boolean),
  forest: Schema.mutableKey(Schema.mutable(Schema.Array(Range))),
  parts: Schema.mutableKey(Schema.mutable(Schema.Array(Part))),
  reference: Schema.mutableKey(Schema.optionalKey(Reference)),
  pending: Schema.mutableKey(Schema.optionalKey(Pending)),
});
export type MemoryTreeState = Schema.Schema.Type<typeof MemoryTreeState>;
export const initialMemoryTreeState = (): MemoryTreeState => ({
  through: null,
  count: 0,
  budget: 0,
  shrinking: false,
  forest: [],
  parts: [],
});

export type SourceRange = { readonly fromEntryId: number; readonly throughEntryId: number };
export type AnchoredNode = StoredNode & SourceRange;
/** Bound one request's <input>: head and tail of an oversized original, never a model overflow. */
const boundedInput = (text: string) => {
  const bytes = memoryBytes(text);
  if (bytes <= MEMORY_INPUT_BYTES) return text;
  const half = Math.floor(MEMORY_INPUT_BYTES / 2);
  const head = utf8Slice(text, half);
  const tail = utf8Slice(text, half, "end");
  return `${head}\n[… ${bytes - memoryBytes(head) - memoryBytes(tail)} bytes omitted; zoom for the original …]\n${tail}`;
};
export const isDegradedMemoryNode = (node: MemoryNode) =>
  node.degraded !== undefined || /^\[excerpt; summary (?:unavailable|deferred)\]/.test(node.text);
export const MEMORY_DEGRADED_WARNING =
  "Some memory summaries are pending; use id+n Zoom or [originals=A..B] with archive_search/archive_read for full evidence.";
const EXCERPT_JOIN = " … ";
/** Only original text or valid summaries may enter this bounded degraded view. */
const excerpt = (sources: readonly string[], limit = MEMORY_NODE_BYTES) => {
  if (!sources.length) return utf8Slice("Original content unavailable.", limit);
  const room = limit - memoryBytes(EXCERPT_JOIN) * (sources.length - 1);
  const each = Math.max(0, Math.floor(room / sources.length));
  return (
    sources
      .map((source) => utf8Slice(source.replace(/\s+/g, " ").trim(), each))
      .join(EXCERPT_JOIN) || utf8Slice("Original content unavailable.", limit)
  );
};

export class MemoryRangeError extends Schema.TaggedError<MemoryRangeError>()("MemoryRangeError", {
  reason: Schema.Literals(["invalid-range", "not-ready"]),
  message: Schema.String,
}) {}

export interface MemoryTreeOptions {
  readonly compactionPolicy: string;
  readonly onConsolidating?: () => void;
  readonly onExcerpt?: (line: { id: number; n: number } & SourceRange & MemoryDegradation) => void;
  readonly summarize: (input: {
    instructions: string;
    context: string;
    signal: AbortSignal;
    onModel?: (model: string) => void;
    previous?: readonly { role: "user" | "assistant"; text: string }[];
    tools?: CompletionChat["tools"];
  }) => Promise<string>;
}

/** Adapter owns originals, node/state persistence and presentation. append atomically
 * publishes an immutable node and its job checkpoint; complete() never runs inside it.
 * The caller serializes the tree's operations for the lifetime of a memory. */
export interface MemoryTreeAdapter {
  readonly state: (signal: AbortSignal) => Promise<MemoryTreeState>;
  readonly node: (entry: number, signal: AbortSignal) => Promise<StoredNode>;
  readonly save: (state: MemoryTreeState, signal: AbortSignal) => Promise<void>;
  readonly append: (
    node: MemoryNode,
    state: MemoryTreeState,
    assigned: (entry: number) => void,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly original: (entry: number, signal: AbortSignal) => Promise<string>;
  readonly context: (
    signal: AbortSignal,
  ) => Promise<{ instructions: string; tools: CompletionChat["tools"] }>;
  readonly render: (nodes: readonly AnchoredNode[]) => string;
}

export function createMemoryTree(adapter: MemoryTreeAdapter, options: MemoryTreeOptions) {
  const { state, node, save, render } = adapter;
  // Follow only the two boundary paths, never scan a summary's entire subtree.
  // Existing immutable nodes already carry all provenance; no index migration or
  // lifetime cache is needed to recover bounds after restart.
  const sourceRange = async (found: StoredNode, signal: AbortSignal): Promise<SourceRange> => {
    const boundary = async (side: 0 | 1) => {
      let edge = found;
      while (edge.children) edge = await node(edge.children[side], signal);
      if (edge.original === undefined) throw new Error("Memory summary has no original");
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
  // Legacy fallback strings are never sources. Recover from retained originals or
  // valid children, with a bounded traversal even for a very old collapsed tree.
  const usableSources = async (found: StoredNode, signal: AbortSignal) => {
    const sources: string[] = [];
    let visited = 0;
    const visit = async (item: StoredNode): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > 128 || sources.length >= 8) return;
      if (!isDegradedMemoryNode(item)) {
        sources.push(item.text);
        return;
      }
      if (item.original !== undefined) {
        try {
          sources.push(await adapter.original(item.original, signal));
        } catch (error) {
          signal.throwIfAborted();
          if (!(error instanceof MemorySummaryError) || error.reason !== "missing-original")
            throw error;
        }
      } else if (item.children) {
        for (const entry of item.children) await visit(await node(entry, signal));
      }
    };
    await visit(found);
    return sources;
  };
  const presented = async (found: StoredNode, signal: AbortSignal): Promise<AnchoredNode> => {
    const base = await anchored(found, signal);
    if (!isDegradedMemoryNode(found)) return base;
    return {
      ...base,
      text: excerpt(await usableSources(found, signal)),
      degraded: found.degraded ?? { reason: "degraded-source", attempts: 0 },
    };
  };
  const nodes = async (parts: readonly Part[], signal: AbortSignal) => {
    const result: AnchoredNode[] = [];
    for (const part of parts) result.push(await presented(await node(part.entry, signal), signal));
    return result;
  };
  const summarize = async (
    sources: readonly string[],
    prefix: string,
    task: { id: number; n: number },
    work: MemoryWork,
    shared: { instructions: string; tools: CompletionChat["tools"] },
  ) => {
    work.signal.throwIfAborted();
    const text = sources.join("\n");
    if (memoryBytes(text) <= MEMORY_NODE_BYTES) return { text };
    const request =
      task.n === 1
        ? `Compaction: compress message ${task.id} into one line of at most 512 bytes\n(about 70 words), the length of this ruler:\n${"-".repeat(512)}`
        : `Compaction: merge lines ${task.id}+${task.n / 2} and ${task.id + task.n / 2}+${task.n / 2}, adjacent, into one line of at most\n512 bytes (about 70 words), the length of this ruler:\n${"-".repeat(512)}\n<chat> may hold their messages, ${task.id} to ${task.id + task.n - 1}, in more detail: take details\nof them from there too.`;
    // Persisted active heads can predate the shared compaction section. Preserve
    // their exact system/cache prefix, but never drop compaction's data/provenance
    // safeguards while waiting for the next ordinary request to update that head.
    const policy = shared.instructions.includes(options.compactionPolicy)
      ? ""
      : `\n${options.compactionPolicy}`;
    const context = `${prefix}\n\n${request}${policy}\n<input>\n${boundedInput(text)}\n</input>`;
    const previous: { role: "user" | "assistant"; text: string }[] = [];
    let shortest: string | undefined;
    let attempts = 0;
    let model: string | undefined;
    let reason: MemoryDegradation["reason"] = "completion-failed";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let answer: string;
      try {
        answer = (
          await work.complete((signal) => {
            attempts += 1;
            return options.summarize({
              instructions: shared.instructions,
              tools: shared.tools,
              context,
              previous: [...previous],
              signal,
              onModel: (selected) => {
                model = selected.slice(0, 256);
              },
            });
          })
        ).trim();
        if (!answer) throw new MemorySummaryError({ reason: "empty-summary" });
      } catch (error) {
        // Retry policy lives at the provider-call boundary; empty/tool/config
        // failures are not evidence of transience. Cancellation always propagates.
        work.signal.throwIfAborted();
        if (!(error instanceof MemorySummaryError)) throw error;
        reason = error.reason;
        break;
      }
      if (shortest === undefined || memoryBytes(answer) < memoryBytes(shortest)) shortest = answer;
      if (memoryBytes(answer) <= MEMORY_NODE_BYTES) return { text: answer };
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
    if (shortest !== undefined) return { text: shortest };
    return {
      text: excerpt(sources),
      degraded: model === undefined ? { reason, attempts } : { reason, attempts, model },
    };
  };

  const fit = async (current: MemoryTreeState, signal: AbortSignal, budget: number) => {
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
        visible.splice(best, 2, await presented(parent, signal));
      }
      current.shrinking = memoryBytes(render(visible)) > target;
    }
    const text = render(visible);
    if (memoryBytes(text) <= budget || !visible.some(isDegradedMemoryNode)) return text;
    // Do not wedge a foreground send when even degraded leaves cannot fit. One
    // inclusive original range retains coverage; these are archive, not Zoom IDs.
    const first = visible[0]!;
    const last = visible.at(-1)!;
    const prefix = `<chat>\nMemory degraded; retrieve originals.\n[originals=${first.fromEntryId}..${last.throughEntryId}]`;
    const tail = "\n</chat>";
    const room = budget - memoryBytes(prefix + tail) - 1;
    if (room < 0) return text;
    const sources = (
      await Promise.all(
        current.parts
          .slice(0, 8)
          .map(async (part) => usableSources(await node(part.entry, signal), signal)),
      )
    )
      .flat()
      .slice(0, 8);
    // Re-read originals/valid children at the final display budget, not excerpts
    // of saved excerpts. The inclusive reference covers any omitted content.
    const bounded = `${prefix}\n${excerpt(sources.slice(0, Math.max(1, Math.floor(room / 16))), room)}${tail}`;
    return memoryBytes(bounded) <= budget ? bounded : prefix + tail;
  };

  const fitViews = async (current: MemoryTreeState, signal: AbortSignal, budget: number) => {
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
  const plan = async (
    current: MemoryTreeState,
    originals: readonly { id: number }[],
    signal: AbortSignal,
  ) => {
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

  const build = async (current: MemoryTreeState, work: MemoryWork, budget: number) => {
    const pending = current.pending!;
    const stopped = new AbortController();
    const signal = AbortSignal.any([work.signal, stopped.signal]);
    const jobs = pending.jobs;
    const shared = await adapter.context(signal);
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
    type Summary = { text: string; degraded?: MemoryDegradation };
    type Completion = { index: number; summary: Summary } | { index: number; error: unknown };
    const active = new Map<number, Promise<Completion>>();
    const launch = (index: number) => {
      const job = jobs[index]!;
      const task = (async () => {
        const context = await prefix(job);
        let sources: string[];
        if (job.n === 1) {
          try {
            sources = [await adapter.original(job.original!, signal)];
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof MemorySummaryError) || error.reason !== "missing-original")
              throw error;
            return {
              text: "Original content unavailable.",
              degraded: { reason: "missing-original" as const, attempts: 0 },
            };
          }
        } else {
          const children = await Promise.all(
            [job.left!, job.right!].map((link) => node(resolve(link), signal)),
          );
          if (children.some(isDegradedMemoryNode)) {
            const usable = (
              await Promise.all(children.map((child) => usableSources(child, signal)))
            )
              .flat()
              .slice(0, 8);
            return {
              text: excerpt(usable),
              degraded: { reason: "degraded-source" as const, attempts: 0 },
            };
          }
          sources = children.map((child) => child.text);
        }
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
        abortableMemoryTask(task, signal).then(
          (summary) => ({ index, summary }),
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
        const value = { id: job.id, n: job.n, ...result.summary };
        const built: MemoryNode =
          job.n === 1
            ? { ...value, original: job.original! }
            : { ...value, children: [resolve(job.left!), resolve(job.right!)] };
        await adapter.append(
          built,
          current,
          (entry) => {
            job.entry = entry;
          },
          signal,
        );
        if (built.degraded && built.degraded.attempts > 0)
          options.onExcerpt?.({
            id: job.id,
            n: job.n,
            ...(await sourceRange({ ...built, entry: job.entry! }, signal)),
            ...built.degraded,
          });
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
      throw new MemoryRangeError({
        reason: "invalid-range",
        message: `No memory line ${id}+${n}. Use an existing id+n or Zoom children: id is a nonnegative integer, n is a power of two (1, 2, 4, ...), id must be divisible by n, and the range must be indexed.`,
      });
    const pending = current.pending?.jobs.find(
      (job) => job.id === id && job.n === n && job.entry !== undefined,
    );
    if (pending?.entry !== undefined) return node(pending.entry, signal);
    const rootRef = current.forest.find((range) => range.id <= id && range.id + range.n >= id + n);
    if (!rootRef)
      throw new MemoryRangeError({
        reason: "not-ready",
        message: `Memory line ${id}+${n} is not ready. Use another current memory range.`,
      });
    let found = await node(rootRef.entry, signal);
    while (found.n > n) {
      if (!found.children) throw new Error("Memory summary has no children");
      found = await node(found.children[id < found.id + found.n / 2 ? 0 : 1], signal);
    }
    return found;
  };

  /** Explicit bounded repair, never an automatic model-spend loop. Rewrite only
   * degraded nodes and their provenance paths; valid siblings remain immutable.
   * New entries are harmless until one final state publication points at them.
   * Originals, IDs, coverage and the adapter's active context head never change. */
  const repair = async (id: number, n: number, work: MemoryWork) => {
    if (n > 32)
      throw new MemoryRangeError({
        reason: "invalid-range",
        message: "Repair at most 32 originals at a time; choose a smaller aligned range.",
      });
    await lookupIndexed(id, n, work.signal);
    const current = await state(work.signal);
    if (current.pending)
      throw new MemoryRangeError({
        reason: "not-ready",
        message: "Finish pending indexing before repair.",
      });
    const shared = await adapter.context(work.signal);
    const replacements = new Map<number, number>();
    let attempted = 0;
    let repaired = 0;
    const publish = async (before: StoredNode, value: MemoryNode) => {
      let entry = before.entry;
      await adapter.append(
        value,
        current,
        (assigned) => {
          entry = assigned;
        },
        work.signal,
      );
      replacements.set(before.entry, entry);
      return { ...value, entry };
    };
    const rebuild = async (found: StoredNode): Promise<StoredNode> => {
      work.signal.throwIfAborted();
      if (found.id + found.n <= id || found.id >= id + n) return found;
      const inside = found.id >= id && found.id + found.n <= id + n;
      if (inside && !isDegradedMemoryNode(found)) return found;
      let children: StoredNode[] = [];
      if (found.children)
        children = await Promise.all(found.children.map((entry) => node(entry, work.signal)));
      // Sequential postorder bounds repair calls and preserves usable siblings.
      for (let i = 0; i < children.length; i += 1) children[i] = await rebuild(children[i]!);
      const changed = children.some((child, i) => child.entry !== found.children?.[i]);
      let value: MemoryNode = Struct.omit(found, ["entry"]);
      if (isDegradedMemoryNode(found))
        value = {
          ...value,
          degraded: found.degraded ?? { reason: "degraded-source", attempts: 0 },
        };
      if (children.length) value = { ...value, children: [children[0]!.entry, children[1]!.entry] };
      if (
        inside &&
        isDegradedMemoryNode(found) &&
        attempted < 8 &&
        !children.some(isDegradedMemoryNode)
      ) {
        attempted += 1;
        let sources: string[] = children.map((child) => child.text);
        try {
          if (found.original !== undefined)
            sources = [await adapter.original(found.original, work.signal)];
          const summary = await summarize(sources, "", found, work, shared);
          value = { ...value, ...summary };
          if (summary.degraded)
            value = {
              ...value,
              degraded: {
                ...summary.degraded,
                attempts: (found.degraded?.attempts ?? 0) + summary.degraded.attempts,
              },
            };
          else {
            value = Struct.omit(value, ["degraded"]);
            repaired += 1;
          }
        } catch (error) {
          work.signal.throwIfAborted();
          if (!(error instanceof MemorySummaryError) || error.reason !== "missing-original")
            throw error;
          value = {
            ...value,
            text: "Original content unavailable.",
            degraded: { reason: "missing-original", attempts: found.degraded?.attempts ?? 0 },
          };
        }
      } else if (!changed) return found;
      // Do not copy an old recursive excerpt while rebuilding a provenance path.
      if (value.degraded)
        value = {
          ...value,
          text: excerpt(await usableSources({ ...value, entry: found.entry }, work.signal)),
        };
      const result = await publish(found, value);
      if (value.degraded)
        options.onExcerpt?.({
          id: found.id,
          n: found.n,
          ...(await sourceRange(result, work.signal)),
          ...value.degraded,
        });
      return result;
    };
    for (const root of current.forest) await rebuild(await node(root.entry, work.signal));
    const replace = (entry: number) => replacements.get(entry) ?? entry;
    current.forest = current.forest.map((range) => ({ ...range, entry: replace(range.entry) }));
    const remap = (parts: Part[]) =>
      parts.map((part) => ({
        ...part,
        entry: replace(part.entry),
        ancestors: part.ancestors.map(replace),
      }));
    current.parts = remap(current.parts);
    if (current.reference) current.reference.parts = remap(current.reference.parts);
    work.signal.throwIfAborted();
    await save(current, work.signal);
    return { attempted, repaired, calls: work.metrics().calls, automaticRetry: false as const };
  };
  const children = async (found: StoredNode, signal: AbortSignal) =>
    Promise.all((found.children ?? []).map((ref) => node(ref, signal)));
  return {
    state,
    node,
    anchored,
    presented,
    nodes,
    save,
    fitViews,
    plan,
    build,
    repair,
    lookupIndexed,
    children,
  };
}
