import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import type { InlineWidgetLanguage } from "../../ipc/inline-widget-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { fencedCode, Markdown } from "./ai-elements/markdown";

export type InlineWidgetSegment =
  | { kind: "markdown"; text: string }
  | { kind: "widget"; language: InlineWidgetLanguage; source: string; closed: boolean; index: number };

export function parseInlineWidgets(text: string): InlineWidgetSegment[] {
  const segments: InlineWidgetSegment[] = [];
  const opening = /^```cake-(html|react)[ \t]*\r?$/gm;
  let cursor = 0;
  let index = 0;
  for (let match = opening.exec(text); match; match = opening.exec(text)) {
    const before = text.slice(cursor, match.index);
    if (before) segments.push({ kind: "markdown", text: before });
    const contentStart = opening.lastIndex + (text[opening.lastIndex] === "\n" ? 1 : 0);
    const closing = /^```[ \t]*\r?$/gm;
    closing.lastIndex = contentStart;
    const end = closing.exec(text);
    if (!end) {
      segments.push({ kind: "widget", language: match[1] as InlineWidgetLanguage, source: text.slice(contentStart), closed: false, index });
      cursor = text.length;
      break;
    }
    segments.push({ kind: "widget", language: match[1] as InlineWidgetLanguage, source: text.slice(contentStart, end.index).trim(), closed: true, index: index++ });
    cursor = closing.lastIndex + (text[closing.lastIndex] === "\n" ? 1 : 0);
    opening.lastIndex = cursor;
  }
  const after = text.slice(cursor);
  if (after) segments.push({ kind: "markdown", text: after });
  return segments.length > 0 ? segments : [{ kind: "markdown", text }];
}

export interface InlineWidgetMarkdownProps {
  children: string;
  messageId: string;
  streaming: boolean;
  store: InlineWidgetStore;
  workspacePath: string;
  sessionId: string;
  model?: { provider: string; id: string };
}

export function InlineWidgetMarkdown(props: InlineWidgetMarkdownProps) {
  return <>{parseInlineWidgets(props.children).map((segment, segmentIndex) => segment.kind === "markdown"
    ? <Markdown key={`markdown-${segmentIndex}`}>{segment.text}</Markdown>
    : <InlineWidget key={`widget-${segment.index}`} {...props} segment={segment} />)}</>;
}

const InlineWidget = observer(function InlineWidget({ segment, messageId, store, workspacePath, sessionId, model, children: context }: InlineWidgetMarkdownProps & { segment: Extract<InlineWidgetSegment, { kind: "widget" }> }) {
  const id = `${sessionId}:${messageId}:${segment.index}`;
  const state = store.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [sourceOpen, setSourceOpen] = useState(false);

  useEffect(() => {
    if (segment.closed && segment.source) store.prepare(id, segment.language, segment.source);
  }, [id, segment.closed, segment.language, segment.source, store]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !state?.compiled || event.data?.source !== "cake-inline-widget" || event.data.token !== state.compiled.token) return;
      if (event.data.type === "height" && typeof event.data.value === "number") setHeight(Math.max(120, Math.min(1_200, Math.ceil(event.data.value))));
      if (event.data.type === "error") store.reportRuntimeError(id, String(event.data.value));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, state?.compiled, store]);

  if (!segment.closed) return <section className="inline-widget inline-widget-building" aria-label="Cake widget is streaming"><div className="inline-widget-rail"><span className="inline-widget-notch" />Receiving {segment.language === "react" ? "React" : "HTML"} widget…</div></section>;
  const status = state?.status ?? "building";
  const displayedSource = state?.source ?? segment.source;
  return <section className={`inline-widget inline-widget-${status}`} aria-label={`Inline ${segment.language} widget`}>
    <div className="inline-widget-rail">
      <span className="inline-widget-notch" aria-hidden="true" />
      <span>{segment.language === "react" ? "React widget" : "HTML widget"}</span>
      <span className="inline-widget-status">{status === "repairing" ? "Repairing…" : status === "building" ? "Building…" : status === "error" ? "Needs attention" : state?.repairSessionId ? "Repaired" : "Ready"}</span>
      <span className="inline-widget-actions">
        <button type="button" onClick={() => setSourceOpen((open) => !open)}>{sourceOpen ? "Hide source" : "Source"}</button>
        <button type="button" disabled={status === "repairing" || status === "building"} onClick={() => void store.repair({ id, workspacePath, sessionId, context, model })}>Repair</button>
      </span>
    </div>
    {status === "error" && <div className="inline-widget-diagnostic" role="alert"><strong>Widget could not render</strong><pre>{state?.diagnostic}</pre></div>}
    {state?.compiled && <iframe ref={iframe} title={`Cake ${segment.language} widget`} sandbox="allow-scripts" referrerPolicy="no-referrer" src={state.compiled.url} style={{ height }} />}
    {sourceOpen && <Markdown className="inline-widget-source">{fencedCode(displayedSource, segment.language === "react" ? "tsx" : "html")}</Markdown>}
  </section>;
});
