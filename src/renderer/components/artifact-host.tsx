import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import mermaid from "mermaid";
import { fencedCode, Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import { observer } from "r-state-tree/react";
import type { ArtifactRecord, CakeArtifactV1 } from "../../ipc/artifact-contract";
import { cakeRequestV1Schema, type CakeRequestView } from "../../ipc/request-contract";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

interface ArtifactHostProps {
  record: ArtifactRecord;
  requested?: boolean;
  onSubmit?(value: unknown): void;
  onCancel?(): void;
  inlineWidgets?: InlineWidgetStore;
}

export function ArtifactHost({ record, requested = false, onSubmit, onCancel, inlineWidgets }: ArtifactHostProps) {
  const artifact = record.artifact;
  return (
    <article className="artifact" data-artifact-id={artifact.id} data-artifact-kind={artifact.kind}>
      <header><div><strong>{artifact.title ?? artifact.id}</strong><span>{artifact.kind} · r{artifact.revision}</span></div></header>
      <div className="artifact-body">
        {artifact.kind === "markdown" ? <Markdown>{artifact.payload.markdown}</Markdown> : null}
        {artifact.kind === "table" ? <TableArtifact artifact={artifact} /> : null}
        {artifact.kind === "diagram" ? <DiagramArtifact artifact={artifact} /> : null}
        {artifact.kind === "form" ? <FormArtifact artifact={artifact} requested={requested} onSubmit={onSubmit} onCancel={onCancel} /> : null}
        {artifact.kind === "media" ? <MediaArtifact artifact={artifact} /> : null}
        {artifact.kind === "diff" ? <pre className="artifact-diff">{artifact.payload.diff}</pre> : null}
        {artifact.kind === "html" ? <HtmlArtifact artifact={artifact} /> : null}
        {artifact.kind === "request" ? <RequestArtifact artifact={artifact} workspacePath={record.workspacePath} requested={requested} onSubmit={onSubmit} onCancel={onCancel} inlineWidgets={inlineWidgets} /> : null}
      </div>
      <details className="artifact-fallback"><summary>Readable fallback</summary><Markdown>{artifact.fallback.markdown}</Markdown></details>
    </article>
  );
}

function RequestArtifact({ artifact, workspacePath, requested, onSubmit, onCancel, inlineWidgets }: { artifact: Extract<CakeArtifactV1, { kind: "request" }>; workspacePath: string; requested: boolean; onSubmit?: (value: unknown) => void; onCancel?: () => void; inlineWidgets?: InlineWidgetStore }) {
  const parsed = cakeRequestV1Schema.safeParse(artifact.payload.request);
  if (!parsed.success) return <div className="notice notice-error"><strong>Request could not render</strong><span>{parsed.error.message}</span></div>;
  const request = parsed.data;
  if (request.view.type === "form") return <RequestForm view={request.view} requested={requested} onSubmit={onSubmit} onCancel={onCancel} />;
  if (!inlineWidgets) return <div className="notice notice-error"><strong>Request widget unavailable</strong><span>Cake could not access its widget compiler.</span></div>;
  return <RequestWidget artifact={artifact} workspacePath={workspacePath} view={request.view} requested={requested} fallback={request.fallback.markdown} onSubmit={onSubmit} onCancel={onCancel} store={inlineWidgets} />;
}

function RequestForm({ view, requested, onSubmit, onCancel }: { view: Extract<CakeRequestView, { type: "form" }>; requested: boolean; onSubmit?: (value: unknown) => void; onCancel?: () => void }) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const submit = (event: FormEvent) => { event.preventDefault(); if (requested) onSubmit?.(values); };
  return <form className="artifact-form" onSubmit={submit}>{view.fields.map((field) => <label key={field.id}><span>{field.label}{field.required ? " *" : ""}</span>{field.type === "textarea" ? <textarea required={field.required} placeholder={field.placeholder} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} /> : field.type === "select" ? <select required={field.required} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}><option value="">Select…</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === "checkbox" ? <input type="checkbox" checked={Boolean(values[field.id])} onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })} /> : <input type={field.type} required={field.required} placeholder={field.placeholder} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: field.type === "number" ? event.target.valueAsNumber : event.target.value })} />}</label>)}{requested && <div className="artifact-actions"><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button type="submit">{view.submitLabel}</Button></div>}</form>;
}

const RequestWidget = observer(function RequestWidget({ artifact, workspacePath, view, requested, fallback, onSubmit, onCancel, store }: { artifact: Extract<CakeArtifactV1, { kind: "request" }>; workspacePath: string; view: Extract<CakeRequestView, { type: "widget" }>; requested: boolean; fallback: string; onSubmit?: (value: unknown) => void; onCancel?: () => void; store: InlineWidgetStore }) {
  const id = `${artifact.sessionId}:request:${artifact.id}:${artifact.revision}`;
  const state = store.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  const [sourceOpen, setSourceOpen] = useState(false);
  useEffect(() => store.prepare(id, view.language, view.source, "request"), [id, store, view.language, view.source]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || !state?.compiled || event.data?.source !== "cake-inline-widget" || event.data.token !== state.compiled.token) return;
      if (event.data.type === "height" && typeof event.data.value === "number") setHeight(Math.max(120, Math.min(1_200, Math.ceil(event.data.value))));
      if (event.data.type === "error") store.reportRuntimeError(id, String(event.data.value));
      if (requested && event.data.type === "submit") onSubmit?.(event.data.value);
      if (requested && event.data.type === "cancel") onCancel?.();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, onCancel, onSubmit, requested, state?.compiled, store]);
  const status = state?.status ?? "building";
  return <section className={`inline-widget inline-widget-${status}`} aria-label={`Custom ${view.language} request`}>
    <div className="inline-widget-rail"><span className="inline-widget-notch" aria-hidden="true" /><span>{view.language === "react" ? "React request" : "HTML request"}</span><span className="inline-widget-status">{status === "repairing" ? "Repairing…" : status === "building" ? "Building…" : status === "error" ? "Needs attention" : requested ? "Waiting for you" : "Completed"}</span><span className="inline-widget-actions"><button type="button" onClick={() => setSourceOpen((open) => !open)}>{sourceOpen ? "Hide source" : "Source"}</button><button type="button" disabled={status === "repairing" || status === "building"} onClick={() => void store.repair({ id, workspacePath, sessionId: artifact.sessionId, context: fallback })}>Repair</button></span></div>
    {status === "error" && <div className="inline-widget-diagnostic" role="alert"><strong>Request widget could not render</strong><pre>{state?.diagnostic}</pre></div>}
    {state?.compiled && <iframe ref={iframe} title={artifact.title ?? artifact.id} sandbox="allow-scripts" referrerPolicy="no-referrer" src={state.compiled.url} style={{ height }} />}
    {sourceOpen && <Markdown className="inline-widget-source">{fencedCode(state?.source ?? view.source, view.language === "react" ? "tsx" : "html")}</Markdown>}
  </section>;
});

function TableArtifact({ artifact }: { artifact: Extract<CakeArtifactV1, { kind: "table" }> }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ column: string; direction: 1 | -1 }>();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle ? artifact.payload.rows.filter((row) => Object.values(row).some((value) => String(value ?? "").toLocaleLowerCase().includes(needle))) : artifact.payload.rows.slice();
    if (sort) filtered.sort((left, right) => compare(left[sort.column], right[sort.column]) * sort.direction);
    return filtered;
  }, [artifact.payload.rows, query, sort]);
  const chooseSort = (column: string) => setSort((current) => current?.column === column ? { column, direction: current.direction === 1 ? -1 : 1 } : { column, direction: 1 });
  const exportCsv = () => download(`${artifact.id}.csv`, [artifact.payload.columns.map((column) => column.label), ...rows.map((row) => artifact.payload.columns.map((column) => String(row[column.id] ?? "")))].map((row) => row.map(csvCell).join(",")).join("\n"), "text/csv");
  return <div className="artifact-table"><div className="artifact-controls"><input aria-label="Filter table" placeholder="Filter rows" value={query} onChange={(event) => setQuery(event.target.value)} /><Button variant="outline" size="sm" onClick={exportCsv}>Export CSV</Button></div><div className="artifact-table-scroll"><table><thead><tr>{artifact.payload.selectable && <th aria-label="Selection" />}{artifact.payload.columns.map((column) => <th key={column.id}><button onClick={() => chooseSort(column.id)}>{column.label}{sort?.column === column.id ? sort.direction === 1 ? " ↑" : " ↓" : ""}</button></th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}>{artifact.payload.selectable && <td><input type="checkbox" aria-label={`Select ${row.id}`} checked={selected.has(row.id)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(row.id)) next.delete(row.id); else next.add(row.id); return next; })} /></td>}{artifact.payload.columns.map((column) => <td key={column.id}>{String(row[column.id] ?? "")}</td>)}</tr>)}</tbody></table></div></div>;
}

function DiagramArtifact({ artifact }: { artifact: Extract<CakeArtifactV1, { kind: "diagram" }> }) {
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
    void mermaid.render(`cake-diagram-${artifact.id.replace(/[^A-Za-z0-9]/g, "-")}-${artifact.revision}`, artifact.payload.source)
      .then((result) => { if (active) setSvg(result.svg); })
      .catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [artifact.id, artifact.payload.source, artifact.revision]);
  if (error) return <div className="notice notice-error"><strong>Diagram could not render</strong><span>{error}</span></div>;
  return svg ? <iframe className="artifact-diagram" title={artifact.title ?? artifact.id} sandbox="" srcDoc={isolatedDocument(svg, "img-src data:; style-src 'unsafe-inline'")} /> : <p>Rendering diagram…</p>;
}

function FormArtifact({ artifact, requested, onSubmit, onCancel }: { artifact: Extract<CakeArtifactV1, { kind: "form" }>; requested: boolean; onSubmit?: (value: unknown) => void; onCancel?: () => void }) {
  const [values, setValues] = useState<Record<string, string | number | boolean>>({});
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit?.(values); };
  return <form className="artifact-form" onSubmit={submit}>{artifact.payload.fields.map((field) => <label key={field.id}><span>{field.label}{field.required ? " *" : ""}</span>{field.type === "textarea" ? <textarea required={field.required} placeholder={field.placeholder} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })} /> : field.type === "select" ? <select required={field.required} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: event.target.value })}><option value="">Select…</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : field.type === "checkbox" ? <input type="checkbox" checked={Boolean(values[field.id])} onChange={(event) => setValues({ ...values, [field.id]: event.target.checked })} /> : <input type={field.type} required={field.required} placeholder={field.placeholder} value={String(values[field.id] ?? "")} onChange={(event) => setValues({ ...values, [field.id]: field.type === "number" ? event.target.valueAsNumber : event.target.value })} />}</label>)}{requested && <div className="artifact-actions"><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button><Button type="submit">{artifact.payload.submitLabel}</Button></div>}</form>;
}

function MediaArtifact({ artifact }: { artifact: Extract<CakeArtifactV1, { kind: "media" }> }) {
  const common = { src: artifact.payload.src, title: artifact.title, referrerPolicy: "no-referrer" as const };
  if (artifact.payload.mediaType === "image") return <img {...common} alt={artifact.payload.alt ?? ""} />;
  if (artifact.payload.mediaType === "audio") return <audio {...common} controls />;
  if (artifact.payload.mediaType === "video") return <video {...common} controls />;
  return <iframe className="artifact-document" {...common} sandbox="" />;
}

function HtmlArtifact({ artifact }: { artifact: Extract<CakeArtifactV1, { kind: "html" }> }) {
  return <iframe className="artifact-html" title={artifact.title ?? artifact.id} sandbox="" referrerPolicy="no-referrer" srcDoc={isolatedDocument(artifact.payload.html, "img-src data:; media-src data:; style-src 'unsafe-inline'")} />;
}

function isolatedDocument(body: string, policy: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${policy}; form-action 'none'; base-uri 'none'"><style>html{color-scheme:light dark;font:14px system-ui}body{margin:12px;overflow:auto}svg,img,video{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

function compare(left: unknown, right: unknown) { return typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true }); }
function csvCell(value: string) { return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

export function downloadArtifactMarkdown(markdown: string) { download("cake-artifacts.md", markdown, "text/markdown"); }
