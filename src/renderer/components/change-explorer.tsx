import { code } from "@streamdown/code";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { observer } from "r-state-tree/react";
import type { SessionChange } from "../../ipc/session-contract";
import { parseDiff } from "./ai-elements/diff-view";
import { Button } from "./ui/button";
import type { WindowStore } from "../stores/window-store";

type HighlightResult = ReturnType<typeof code.highlight>;
type HighlightTokens = NonNullable<HighlightResult>["tokens"];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

const languages: Record<string, HighlightLanguage> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", go: "go", html: "html", java: "java", js: "javascript", jsx: "jsx",
  json: "json", md: "markdown", mdx: "mdx", php: "php", py: "python", rb: "ruby", rs: "rust", scss: "scss", sh: "shellscript",
  sql: "sql", svelte: "svelte", ts: "typescript", tsx: "tsx", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml"
};

function languageFor(path: string): HighlightLanguage {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return languages[extension] ?? "markdown";
}

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  change?: SessionChange;
}

function fileTree(changes: SessionChange[]) {
  const root: FileTreeNode = { name: "", path: "", children: new Map() };
  for (const change of changes) {
    let parent = root;
    for (const [index, name] of change.path.split("/").filter(Boolean).entries()) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        parent.children.set(name, node);
      }
      if (index === change.path.split("/").filter(Boolean).length - 1) node.change = change;
      parent = node;
    }
  }
  return root;
}

function ChangeTree({ nodes, selectedPath, onSelect }: { nodes: Map<string, FileTreeNode>; selectedPath: string; onSelect(path: string): void }) {
  return <ul>{[...nodes.values()].map((node) => <li key={node.path}>{node.change
    ? <button className={node.path === selectedPath ? "active" : ""} onClick={() => onSelect(node.path)}><span>{node.name}</span><small>+{node.change.additions} −{node.change.deletions}</small></button>
    : <><div><span className="change-tree-chevron">⌄</span><span>{node.name}</span></div><ChangeTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} /></>}</li>)}</ul>;
}

function HighlightedDiff({ change }: { change: SessionChange }) {
  const lines = useMemo(() => parseDiff(change.diff), [change.diff]);
  const source = useMemo(() => lines.map((line) => line.kind === "meta" ? "" : line.content).join("\n"), [lines]);
  const [tokens, setTokens] = useState<HighlightTokens>();

  useEffect(() => {
    let active = true;
    setTokens(undefined);
    const apply = (result: NonNullable<HighlightResult>) => { if (active) setTokens(result.tokens); };
    const immediate = code.highlight({ code: source, language: languageFor(change.path), themes: code.getThemes() }, apply);
    if (immediate) apply(immediate);
    return () => { active = false; };
  }, [change.path, source]);

  return <div className="change-explorer-diff" role="table" aria-label={`Full session changes to ${change.path}`}>{lines.map((line, index) => line.kind === "meta"
    ? <div className="change-explorer-line meta" role="row" key={line.key}><span /><span /><code>{line.content}</code></div>
    : <div className={`change-explorer-line ${line.kind}`} role="row" key={line.key}>
        <span>{line.oldNumber}</span><span>{line.newNumber}</span><code><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</b>{(tokens?.[index] ?? []).length > 0
          ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle as CSSProperties} key={`${tokenIndex}-${token.content}`}>{token.content}</i>)
          : line.content || " "}</code>
      </div>)}</div>;
}

export const ChangeExplorer = observer(function ChangeExplorer({ store }: { store: WindowStore }) {
  const change = store.selectedSessionChange;
  const tree = useMemo(() => fileTree(store.sessionChanges), [store.sessionChanges]);
  if (!change) return <main className="change-explorer-empty"><div><small>{store.sessionTitle}</small><h1>No session changes</h1><p>This session has no recorded file diffs.</p><Button variant="outline" onClick={() => store.closeChangeExplorer()}>Return to chat</Button></div></main>;
  return <main className="change-explorer">
    <section className="change-explorer-file">
      <header><div><small>Session changes · {store.sessionTitle}</small><h1>{change.path}</h1></div><span><b>+{change.additions}</b><i>−{change.deletions}</i></span></header>
      <HighlightedDiff change={change} />
    </section>
    <aside className="change-explorer-tree"><header><div><strong>Changed files</strong><small>{store.sessionChanges.length} {store.sessionChanges.length === 1 ? "file" : "files"}</small></div><Button variant="ghost" size="sm" onClick={() => store.closeChangeExplorer()}>Done</Button></header><nav aria-label="Changed files"><ChangeTree nodes={tree.children} selectedPath={change.path} onSelect={(path) => store.selectChangeExplorerFile(path)} /></nav></aside>
  </main>;
});
