import { useEffect, useMemo, useState, type FormEvent } from "react";
import mermaid from "mermaid";
import { Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import type { ArtifactRecord, CakeArtifactV1 } from "../../ipc/artifact-contract";

interface ArtifactHostProps {
  record: ArtifactRecord;
  requested?: boolean;
  onSubmit?(value: unknown): void;
  onCancel?(): void;
}

export function ArtifactHost({ record, requested = false, onSubmit, onCancel }: ArtifactHostProps) {
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
      </div>
      <details className="artifact-fallback"><summary>Readable fallback</summary><Markdown>{artifact.fallback.markdown}</Markdown></details>
    </article>
  );
}

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
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; ${policy}; form-action 'none'; base-uri 'none'; navigate-to 'none'"><style>html{color-scheme:light dark;font:14px system-ui}body{margin:12px;overflow:auto}svg,img,video{max-width:100%;height:auto}</style></head><body>${body}</body></html>`;
}

function compare(left: unknown, right: unknown) { return typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true }); }
function csvCell(value: string) { return /[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value; }
function download(name: string, content: string, type: string) { const url = URL.createObjectURL(new Blob([content], { type })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }

export function downloadArtifactMarkdown(markdown: string) { download("cake-artifacts.md", markdown, "text/markdown"); }
