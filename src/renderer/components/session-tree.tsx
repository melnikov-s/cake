import type { SessionTreeNode } from "../../ipc/session-contract";

interface SessionTreeRow {
  node: SessionTreeNode;
  depth: number;
}

export function visibleSessionTree(nodes: SessionTreeNode[]): SessionTreeNode[] {
  const visit = (node: SessionTreeNode): SessionTreeNode[] => {
    const children = node.children.flatMap(visit);
    const visibleMessage = node.type === "message" && (node.messageRole === "user" || node.messageRole === "assistant") && Boolean(node.preview);
    if (!visibleMessage) return children;
    return [{ ...node, children }];
  };
  return nodes.flatMap(visit);
}

export function flattenSessionTree(nodes: SessionTreeNode[]): SessionTreeRow[] {
  const rows: SessionTreeRow[] = [];
  const visit = (node: SessionTreeNode, depth: number) => {
    rows.push({ node, depth });
    const childDepth = node.children.length > 1 ? depth + 1 : depth;
    for (const child of node.children) visit(child, childDepth);
  };
  for (const node of nodes) visit(node, 0);
  return rows;
}

export function SessionTree({ nodes, onNavigate, onFork }: { nodes: SessionTreeNode[]; onNavigate(id: string): void; onFork(id: string): void }) {
  const rows = flattenSessionTree(visibleSessionTree(nodes));
  return <ul className="session-tree" role="tree">{rows.map(({ node, depth }) => <li
    key={node.id}
    className={`session-tree-row ${node.active ? "active" : ""} ${depth > 0 ? "branched" : ""}`}
    role="treeitem"
    aria-level={depth + 1}
    style={{ marginLeft: `${depth * 18}px` }}
  ><div><button title={node.messageRole === "user" ? "Resume from this message" : "Resume from this response"} onClick={() => onNavigate(node.id)}>{node.messageRole && <span className={`session-tree-role role-${node.messageRole}`}>{node.messageRole}</span>}<span>{node.label || node.preview}</span></button><button className="session-tree-fork" aria-label={`Fork from ${node.preview}`} title="Fork from here" onClick={() => onFork(node.id)}>Fork</button></div></li>)}</ul>;
}
