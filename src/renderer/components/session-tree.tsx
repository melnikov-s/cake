import type { SessionTreeEntry } from "../../ipc/session-contract";
import { Button } from "./ui/button";
import { NavItem } from "./ui/nav-item";

interface SessionTreeRow {
  node: SessionTreeEntry;
  depth: number;
}

function isVisibleMessage(entry: SessionTreeEntry) {
  return (
    entry.type === "message" &&
    (entry.messageRole === "user" || entry.messageRole === "assistant") &&
    Boolean(entry.preview)
  );
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
    for (let index = children.length - 1; index >= 0; index -= 1)
      stack.push({ node: children[index]!, depth: childDepth });
  }
  return rows;
}

export function SessionTree({
  nodes,
  onNavigate,
  onFork,
}: {
  nodes: SessionTreeEntry[];
  onNavigate(id: string): void;
  onFork(id: string): void;
}) {
  const rows = flattenSessionTree(visibleSessionTree(nodes));
  return (
    <ul className="m-0 list-none p-0" role="tree">
      {rows.map(({ node, depth }) => (
        <li
          key={node.id}
          className={`group/row relative text-xs ${depth > 0 ? "border-l border-border" : ""}`}
          role="treeitem"
          aria-level={depth + 1}
          style={{ marginLeft: `${depth * 18}px` }}
        >
          <div className="relative flex min-w-0 items-center gap-1.5 px-2 py-0.5">
            {node.active && (
              <span
                aria-hidden="true"
                className="absolute -left-[1px] size-1 -translate-x-1/2 rounded-full bg-accent"
              />
            )}
            <NavItem
              className="flex-1"
              active={node.active}
              title={
                node.messageRole === "user"
                  ? "Resume from this message"
                  : "Resume from this response"
              }
              onClick={() => onNavigate(node.id)}
              icon={
                node.messageRole ? (
                  <span
                    data-slot="session-tree-role"
                    className={`w-18 shrink-0 font-mono text-[10px] text-right ${
                      node.messageRole === "user" ? "text-accent" : "text-success"
                    }`}
                  >
                    {node.messageRole}
                  </span>
                ) : null
              }
              label={<span className="truncate">{node.label || node.preview}</span>}
              trailing={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 py-0 text-xs text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 hover:text-foreground"
                  aria-label={`Fork from ${node.preview}`}
                  title="Fork from here"
                  onClick={(event) => {
                    event.stopPropagation();
                    onFork(node.id);
                  }}
                >
                  Fork
                </Button>
              }
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
