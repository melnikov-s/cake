import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Conversation, Cursor } from "@earendil-works/pi-durable";
import { Option, Schema } from "effect";
import { MemoryNode, type MemoryTreeState, type StoredNode } from "../opt-memory/memory-tree";

interface RetainedNode extends StoredNode {
  readonly from: number;
  readonly through: number;
}

/** Version 4 reset the index to backfill historical tools. Its immutable older
 * summaries survive. Recover a complete chronological prefix using those nodes,
 * without invoking a model or assigning old ranges to different originals. */
export async function recoverRetainedMemory(
  root: Conversation,
  current: MemoryTreeState,
  signal: AbortSignal,
): Promise<MemoryTreeState | undefined> {
  const context = withAbortSignal(signal, BACKGROUND_CONTEXT);
  // Migration-local lookup only; ordinary memory reads retain no history cache.
  const nodes = new Map<number, RetainedNode>();
  const starts = new Map<number, RetainedNode[]>();
  let cursor: Cursor | undefined;
  do {
    const page = await root.entries({ order: "ascending" }, 128, cursor, context);
    for (const entry of page.items) {
      signal.throwIfAborted();
      if (entry.kind !== "cake.chat-memory-node/v1") continue;
      const decoded = Schema.decodeUnknownOption(MemoryNode)(entry.data);
      if (Option.isNone(decoded)) continue;
      const node = decoded.value;
      if (!Number.isInteger(Math.log2(node.n)) || node.id % node.n !== 0) continue;
      let retained: RetainedNode;
      if (node.n === 1 && node.original !== undefined && !node.children) {
        retained = { ...node, entry: entry.id, from: node.original, through: node.original };
      } else {
        const left = node.children && nodes.get(node.children[0]);
        const right = node.children && nodes.get(node.children[1]);
        if (
          !left ||
          !right ||
          left.id !== node.id ||
          left.n * 2 !== node.n ||
          right.id !== node.id + left.n ||
          right.n !== left.n ||
          left.through >= right.from
        )
          continue;
        retained = { ...node, entry: entry.id, from: left.from, through: right.through };
      }
      nodes.set(entry.id, retained);
      const candidates = starts.get(node.id) ?? [];
      candidates.push(retained);
      starts.set(node.id, candidates);
    }
    cursor = page.next;
  } while (cursor !== undefined);

  const forest: RetainedNode[] = [];
  let count = 0;
  let through = -1;
  let size = Infinity;
  while (true) {
    // Coverage, rather than newest write, distinguishes the old completed index
    // from a partial backfill with reused id+n ranges and earlier originals.
    const next = starts
      .get(count)
      ?.filter((node) => node.from > through && node.n < size)
      .sort((a, b) => b.through - a.through || b.n - a.n || b.entry - a.entry)[0];
    if (!next) break;
    forest.push(next);
    count += next.n;
    through = next.through;
    size = next.n;
  }
  if (through <= (current.through ?? -1)) return undefined;

  const parts: MemoryTreeState["parts"] = [];
  const expand = (node: RetainedNode, ancestors: number[]) => {
    if (!node.children) {
      parts.push({ id: node.id, n: node.n, entry: node.entry, ancestors });
      return;
    }
    for (const childId of node.children) {
      const child = nodes.get(childId);
      if (!child) throw new Error(`Retained memory child ${childId} is unavailable`);
      expand(child, [node.entry, ...ancestors]);
    }
  };
  for (const node of forest) expand(node, []);
  return {
    through,
    count,
    budget: current.budget,
    shrinking: true,
    forest: forest.map(({ id, n, entry }) => ({ id, n, entry })),
    parts,
  };
}
