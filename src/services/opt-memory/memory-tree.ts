import { Schema } from "effect";
import type { CompletionChat } from "../../contracts/pi/model-data";
import {
  MEMORY_INPUT_BYTES,
  MEMORY_NODE_BYTES,
  MEMORY_SUMMARY_FAILURES,
  memoryBytes,
  utf8Slice,
} from "./memory-policy";
import { abortableMemoryTask, MemorySummaryError, type MemoryWork } from "./memory-work";

const Id = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Range = Schema.Struct({ id: Id, n: Schema.Int.check(Schema.isGreaterThan(0)), entry: Id });
export const MemoryNode = Schema.Struct({
  id: Range.fields.id,
  n: Range.fields.n,
  text: Schema.NonEmptyString,
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

export class MemoryRangeError extends Schema.TaggedError<MemoryRangeError>()("MemoryRangeError", {
  reason: Schema.Literals(["invalid-range", "not-ready"]),
  message: Schema.String,
}) {}

export interface MemoryTreeOptions {
  readonly compactionPolicy: string;
  readonly onConsolidating?: () => void;
  readonly onExcerpt?: (line: { id: number; n: number }) => void;
  readonly summarize: (input: {
    instructions: string;
    context: string;
    signal: AbortSignal;
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
  const nodes = async (parts: readonly Part[], signal: AbortSignal) => {
    const result: AnchoredNode[] = [];
    for (const part of parts) result.push(await anchored(await node(part.entry, signal), signal));
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
    if (memoryBytes(text) <= MEMORY_NODE_BYTES) return text;
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
        if (!answer) throw new MemorySummaryError({ reason: "empty-summary" });
      } catch (error) {
        // Cancellation propagates. A failed answer (provider error, tool call,
        // oversized or empty output) is retried, then replaced by an excerpt.
        if (!(error instanceof MemorySummaryError)) throw error;
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
    type Completion = { index: number; text: string } | { index: number; error: unknown };
    const active = new Map<number, Promise<Completion>>();
    const launch = (index: number) => {
      const job = jobs[index]!;
      const task = (async () => {
        const context = await prefix(job);
        const sources =
          job.n === 1
            ? [await adapter.original(job.original!, signal)]
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
        abortableMemoryTask(task, signal).then(
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
        const value = { id: job.id, n: job.n, text: result.text };
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

  const children = async (found: StoredNode, signal: AbortSignal) =>
    Promise.all((found.children ?? []).map((ref) => node(ref, signal)));
  return { state, node, anchored, nodes, save, fitViews, plan, build, lookupIndexed, children };
}
