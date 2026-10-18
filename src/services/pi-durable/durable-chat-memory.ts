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
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { MEMORY_COMPACTOR_PROMPT, MEMORY_NODE_BYTES, memoryBytes } from "./durable-memory-policy";
import type { DurableChatMemoryView } from "./durable-chat-data";
import {
  durableInputPresentation,
  withoutDurableInputPresentation,
} from "./durable-input-presentation";
import type { ContextInspection } from "../../contracts/conversations/context-inspection";
import { contextMessage } from "../pi/runtime/context-outline";
import { splitContextReminders } from "../pi/runtime/session-context-reminders";

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
const State = Schema.Struct({
  through: Schema.mutableKey(Schema.NullOr(Id)),
  count: Schema.mutableKey(Id),
  budget: Schema.mutableKey(Id),
  shrinking: Schema.mutableKey(Schema.Boolean),
  forest: Schema.mutableKey(Schema.mutable(Schema.Array(Range))),
  parts: Schema.mutableKey(Schema.mutable(Schema.Array(Part))),
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
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial,
});
// Immutable nodes use indexed entry reads, not document families: Durable retains loaded
// document trackers for its lifetime. Only StateDoc (bounded view + logarithmic forest) is live.
const NodeEntry = defineEntry<Node>("cake.chat-memory-node/v1");

// SAFETY: SDK ids are branded numbers; values here come from Durable or schema-validated persisted Id fields.
const entryId = (value: number) => value as EntryId;

export interface DurableMemoryOptions {
  readonly budget: () => number;
  readonly summarize: (input: {
    instructions: string;
    context: string;
    signal: AbortSignal;
  }) => Promise<string>;
}

function durableMessageText(message: Message): string {
  if (message.role === "system") return "";
  if (message.role === "assistant")
    return (
      message.content
        .flatMap((block) => {
          if (block.type === "text") return [`talk: ${block.text}`];
          if (block.type === "toolCall")
            return [`tool: ${block.name} ${JSON.stringify(block.arguments)}`];
          return []; // Reasoning remains in the authoritative transcript, never in the summary index.
        })
        .join("\n") + (message.errorMessage ? `\nerror: ${message.errorMessage}` : "")
    );
  const rawText = Array.isArray(message.content)
    ? message.content
        .map((block) =>
          block.type === "text" ? block.text : "[image attached; zoom for the original]",
        )
        .join("\n")
    : message.content;
  const input = message.role === "user" ? durableInputPresentation(rawText) : undefined;
  const text = input?.body ?? rawText;
  if (message.role === "toolResult")
    return `echo: ${message.toolName}${message.isError ? " failed" : ""}: ${text}`;
  if (input?.subagentReport)
    return `work: received worker report ${JSON.stringify(input.subagentReport)}; receipt does not establish user-facing communication: ${text}`;
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
    return [...work, `user: ${context.text}`].join("\n");
  }
  const report = parseCrossSessionMessage(text);
  if (report) return `work: [${report.metadata.sender.title}] ${report.text}`;
  if (/^Background subagent\b/.test(text)) return `work: ${text}`;
  return `user: ${text}`;
}
const sourceText = (entry: EntryRecord) => {
  // Only originals enter the tree. Reset handoffs, system declarations, emergency
  // compaction summaries and our derived nodes must never be summarized a second time.
  if (!["pi.user", "pi.assistant", "pi.tool-result"].includes(entry.kind)) return "";
  return entry.model?.map(durableMessageText).filter(Boolean).join("\n") ?? "";
};
const render = (nodes: readonly StoredNode[]) =>
  `<chat>\n${nodes
    .map((node) => `${node.id}+${node.n}|${node.text.replace(/\s*\n\s*/g, " ")}`)
    .join("\n")}\n</chat>`;

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
  const nodes = async (parts: readonly Part[], signal: AbortSignal) => {
    const result: StoredNode[] = [];
    for (const part of parts) result.push(await node(part.entry, signal));
    return result;
  };
  const save = (value: State, signal: AbortSignal) =>
    root.commit(async (tx) => {
      Object.assign(await tx.doc(StateDoc, root.id), value);
    }, contextFor(signal));

  const summarize = async (text: string, prefix: string, signal: AbortSignal) => {
    if (memoryBytes(text) <= MEMORY_NODE_BYTES) return text;
    const attempts: string[] = [];
    let feedback = "";
    for (let attempt = 0; attempt < 5; attempt += 1) {
      signal.throwIfAborted();
      const answer = (
        await options.summarize({
          instructions: MEMORY_COMPACTOR_PROMPT,
          context: `${prefix}\n\nCompress or merge <input> into one line of at most 512 UTF-8 bytes. Size ruler:\n${"-".repeat(MEMORY_NODE_BYTES)}\n<input>\n${text}\n</input>${feedback}`,
          signal,
        })
      ).trim();
      signal.throwIfAborted();
      if (!answer) throw new Error("Cake Chat memory summarizer returned an empty summary");
      attempts.push(answer);
      if (memoryBytes(answer) <= MEMORY_NODE_BYTES) break;
      const cut = Buffer.from(answer)
        .subarray(0, MEMORY_NODE_BYTES)
        .toString("utf8")
        .replace(/\uFFFD$/, "");
      feedback = `\nYour previous line is ${memoryBytes(answer)} bytes: ${answer}\nRewrite it to fit before this cut:\n${cut}| LIMIT`;
    }
    return attempts.reduce((a, b) => (memoryBytes(a) <= memoryBytes(b) ? a : b));
  };

  const fit = async (current: State, signal: AbortSignal) => {
    const budget = Schema.decodeUnknownSync(Schema.Int.check(Schema.isGreaterThan(0)))(
      options.budget(),
    );
    current.budget = budget;
    const visible = await nodes(current.parts, signal);
    if (memoryBytes(render(visible)) > budget) current.shrinking = true;
    if (current.shrinking) {
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
        visible.splice(best, 2, parent);
      }
      current.shrinking = memoryBytes(render(visible)) > target;
    }
    return render(visible);
  };

  const append = async (
    current: State,
    original: EntryRecord,
    text: string,
    signal: AbortSignal,
  ) => {
    const prefix = render(await nodes(current.parts, signal));
    const planned: { id: number; n: number; text: string; left?: number }[] = [
      {
        id: current.count,
        n: 1,
        text: await summarize(text, prefix, signal),
      },
    ];
    const forest = [...current.forest];
    let right = planned[0]!;
    while (forest.at(-1)?.n === right.n) {
      const left = forest.pop()!;
      const source = `${(await node(left.entry, signal)).text}\n${right.text}`;
      right = {
        id: left.id,
        n: left.n * 2,
        text: await summarize(source, prefix, signal),
        left: left.entry,
      };
      planned.push(right);
    }
    signal.throwIfAborted();
    // All model calls precede the transaction. The leaf, its carry-chain parents,
    // source cursor and view references commit together: restart never indexes a source twice.
    await root.commit(async (tx) => {
      let previous: EntryId | undefined;
      for (const step of planned) {
        const stored = await tx.appendEntry(NodeEntry, root.id, {
          data: {
            id: step.id,
            n: step.n,
            text: step.text,
            ...(step.left === undefined
              ? { original: original.id }
              : { children: [entryId(step.left), previous!] }),
          },
        });
        previous = stored.id;
        if (step.n === 1)
          current.parts.push({ id: step.id, n: 1, entry: stored.id, ancestors: [] });
        else
          for (const part of current.parts)
            if (part.id >= step.id && part.id + part.n <= step.id + step.n)
              part.ancestors.push(stored.id);
      }
      forest.push({ id: right.id, n: right.n, entry: previous! });
      current.forest = forest;
      current.count += 1;
      current.through = original.id;
      Object.assign(await tx.doc(StateDoc, root.id), current);
    }, contextFor(signal));
    await fit(current, signal);
    await save(current, signal);
  };

  const synchronize = async (
    signal: AbortSignal,
    cutoff?: EntryId,
  ): Promise<DurableChatMemoryView> => {
    const current = await state(signal);
    const newest =
      cutoff ?? (await root.entries({}, 1, undefined, contextFor(signal))).items[0]?.id;
    if (newest !== undefined) {
      let cursor: Cursor | undefined;
      const query: Omit<EntryQuery, "conversationId"> = { order: "ascending", maxEntryId: newest };
      if (current.through !== null)
        Object.assign(query, { minEntryId: entryId(current.through + 1) });
      do {
        const page = await root.entries(query, 64, cursor, contextFor(signal));
        for (const original of page.items) {
          const text = sourceText(original);
          if (text) await append(current, original, text, signal);
          else current.through = original.id;
        }
        cursor = page.next;
      } while (cursor !== undefined);
    }
    const text = await fit(current, signal);
    await save(current, signal);
    if (memoryBytes(text) > current.budget)
      throw new Error("Cake Chat history cannot fit its memory budget");
    return {
      text,
      bytes: memoryBytes(text),
      sourceCount: current.count,
      partCount: current.parts.length,
    };
  };

  const lookup = async (id: number, n: number, signal: AbortSignal) => {
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
      throw new Error(`No memory line ${id}+${n}`);
    const rootRef = current.forest.find((range) => range.id <= id && range.id + range.n >= id + n);
    if (!rootRef) throw new Error(`No memory line ${id}+${n}`);
    let found = await node(rootRef.entry, signal);
    while (found.n > n) {
      if (!found.children) throw new Error("Cake Chat summary has no children");
      found = await node(found.children[id < found.id + found.n / 2 ? 0 : 1], signal);
    }
    return found;
  };

  const zoom = async (id: number, n: number, signal: AbortSignal) => {
    const found = await lookup(id, n, signal);
    if (found.n === 1) {
      if (found.original === undefined) throw new Error("Cake Chat summary has no original");
      const original = (await storage.entry(root.id, entryId(found.original), contextFor(signal)))
        ?.entry;
      if (!original) throw new Error("Cake Chat original is missing");
      return { text: `${id}+0|${sourceText(original)}`, messages: original.model ?? [] };
    }
    const children = await Promise.all(found.children!.map((ref) => node(ref, signal)));
    return {
      text: children.map((child) => `${child.id}+${child.n}|${child.text}`).join("\n"),
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
