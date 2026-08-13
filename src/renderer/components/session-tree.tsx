import type { SessionTreeEntry } from "../../ipc/session-contract";

interface SessionTreeRow {
  node: SessionTreeEntry;
  depth: number;
}

function isVisibleMessage(entry: SessionTreeEntry) {
  return entry.type === "message"
    && (entry.messageRole === "user" || entry.messageRole === "assistant")
    && Boolean(entry.preview);
}

export function visibleSessionTree(entries: SessionTreeEntry[]): SessionTreeEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const visibleIds = new Set(entries.filter(isVisibleMessage).map((entry) => entry.id));
  return entries.filter(isVisibleMessage).map((entry) => {
    let parentId = entry.parentId;
    const visited = new Set<string>();
    while (parentId && !visibleIds.has(parentId) && !visited.has(parentId)) {
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return parentId === entry.parentId ? entry : { ...entry, parentId };
  });
}

export function flattenSessionTree(entries: SessionTreeEntry[]): SessionTreeRow[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const childrenByParent = new Map<string, SessionTreeEntry[]>();
  const roots: SessionTreeEntry[] = [];
  for (const entry of entries) {
    if (!entry.parentId || entry.parentId === entry.id || !byId.has(entry.parentId)) {
      roots.push(entry);
      continue;
    }
    const children = childrenByParent.get(entry.parentId) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentId, children);
  }

  const rows: SessionTreeRow[] = [];
  const stack = roots.toReversed().map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    const row = stack.pop()!;
    rows.push(row);
    const children = childrenByParent.get(row.node.id) ?? [];
    const childDepth = children.length > 1 ? row.depth + 1 : row.depth;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index]!, depth: childDepth });
  }
  return rows;
}

export function SessionTree({ nodes, onNavigate, onFork }: { nodes: SessionTreeEntry[]; onNavigate(id: string): void; onFork(id: string): void }) {
  const rows = flattenSessionTree(visibleSessionTree(nodes));
  return <ul className="session-tree" role="tree">{rows.map(({ node, depth }) => <li
    key={node.id}
    className={`session-tree-row ${node.active ? "active" : ""} ${depth > 0 ? "branched" : ""}`}
    role="treeitem"
    aria-level={depth + 1}
    style={{ marginLeft: `${depth * 18}px` }}
  ><div><button title={node.messageRole === "user" ? "Resume from this message" : "Resume from this response"} onClick={() => onNavigate(node.id)}>{node.messageRole && <span className={`session-tree-role role-${node.messageRole}`}>{node.messageRole}</span>}<span>{node.label || node.preview}</span></button><button className="session-tree-fork" aria-label={`Fork from ${node.preview}`} title="Fork from here" onClick={() => onFork(node.id)}>Fork</button></div></li>)}</ul>;
}
