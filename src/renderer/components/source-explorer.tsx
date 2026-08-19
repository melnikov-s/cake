import { useState, type CSSProperties, type ReactNode } from "react";
import { PanelResizeHandle } from "./panel-resize-handle";

export interface SourceTreeNode<T> {
  name: string;
  path: string;
  value?: T;
  children: Map<string, SourceTreeNode<T>>;
}

export function sourceTree<T>(values: T[], pathFor: (value: T) => string) {
  const root: SourceTreeNode<T> = { name: "", path: "", children: new Map() };
  for (const value of values) {
    const names = pathFor(value).split("/").filter(Boolean);
    let parent = root;
    names.forEach((name, index) => {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        parent.children.set(name, node);
      }
      if (index === names.length - 1) node.value = value;
      parent = node;
    });
  }
  return root;
}

export function SourceTree<T>({
  nodes,
  selectedPath,
  onSelect,
  collapsible = false,
  fileMeta,
}: {
  nodes: Map<string, SourceTreeNode<T>>;
  selectedPath?: string | null;
  onSelect(path: string): void;
  collapsible?: boolean;
  fileMeta?(value: T): ReactNode;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  return (
    <ul>
      {[...nodes.values()].map((node) => (
        <li key={node.path}>
          {node.value !== undefined ? (
            <button
              className={node.path === selectedPath ? "active" : ""}
              title={collapsible ? node.path : undefined}
              onClick={() => onSelect(node.path)}
            >
              <span>{node.name}</span>
              {fileMeta?.(node.value)}
            </button>
          ) : (
            <>
              {collapsible ? (
                <button
                  className="workspace-tree-directory"
                  aria-expanded={!collapsed.has(node.path)}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(node.path)) next.delete(node.path);
                      else next.add(node.path);
                      return next;
                    })
                  }
                >
                  <span className="change-tree-chevron">
                    {collapsed.has(node.path) ? "›" : "⌄"}
                  </span>
                  <span>{node.name}</span>
                </button>
              ) : (
                <div>
                  <span className="change-tree-chevron">⌄</span>
                  <span>{node.name}</span>
                </div>
              )}
              {!collapsed.has(node.path) && (
                <SourceTree
                  nodes={node.children}
                  selectedPath={selectedPath}
                  onSelect={onSelect}
                  collapsible={collapsible}
                  fileMeta={fileMeta}
                />
              )}
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

export function SourceExplorerLayout({
  className = "",
  resizeLabel,
  file,
  sidebar,
}: {
  className?: string;
  resizeLabel: string;
  file: ReactNode;
  sidebar: ReactNode;
}) {
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [resizingPanel, setResizingPanel] = useState(false);
  const style: CSSProperties & Record<"--explorer-sidebar-width", string> = {
    "--explorer-sidebar-width": `${sidebarWidth}px`,
  };
  return (
    <main
      className={`change-explorer ${className} ${resizingPanel ? "is-resizing" : ""}`.trim()}
      style={style}
    >
      <section className="change-explorer-file">{file}</section>
      <PanelResizeHandle
        className="explorer-resize-handle"
        label={resizeLabel}
        value={sidebarWidth}
        min={240}
        max={Math.max(240, window.innerWidth - 360)}
        edge="right"
        onChange={setSidebarWidth}
        onResizeStart={() => setResizingPanel(true)}
        onResizeEnd={() => setResizingPanel(false)}
      />
      <aside className="change-explorer-tree">{sidebar}</aside>
    </main>
  );
}
