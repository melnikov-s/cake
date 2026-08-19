/* Adapted from Vercel AI Elements tool.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Uses Cake tool states. */
import { useState } from "react";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../../../ipc/json-contract";
import type { UiPart } from "../../../ipc/session-contract";
import { DiffView } from "./diff-view";
import { fencedCode, Markdown } from "./markdown";
import { SubagentTool } from "./subagent-tool";

function parseJson(value: string) {
  try {
    return jsonValueSchema.parse(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function oneLine(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function toolTitle(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.name === "edit" && part.filePath) return `edit ${part.filePath}`;

  const parsed = parseJson(part.input);
  const structuredResult = jsonObjectSchema.safeParse(parsed);
  const structured = structuredResult.success ? structuredResult.data : undefined;
  const parsedString = z.string().safeParse(parsed);
  const detail = part.name === "bash"
    ? part.input
    : part.filePath
      ?? ["command", "path", "file_path", "query", "pattern", "url"]
        .map((key) => z.string().safeParse(structured?.[key]))
        .find((result) => result.success)?.data
      ?? (parsedString.success ? parsedString.data : parsed === undefined ? part.input : "");
  const summary = oneLine(detail);
  return summary ? `${part.name} ${summary}` : part.name;
}

function toolCode(value: string, className: string) {
  const parsed = parseJson(value);
  const source = parsed === undefined ? value : JSON.stringify(parsed, null, 2);
  const language = parsed === undefined ? "text" : "json";
  return <Markdown className={className}>{fencedCode(source, language)}</Markdown>;
}

function editPreview(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.name !== "edit") return undefined;
  if (part.diff) return part.diff;
  try {
    const input = z.object({
      edits: z.array(z.object({ oldText: z.string().optional(), newText: z.string().optional() })).optional(),
    }).parse(JSON.parse(part.input));
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (edits.length === 0) return undefined;
    return edits.flatMap((edit, index) => [
      ...(index > 0 ? [`@@ change ${index + 1} @@`] : []),
      ...(edit.oldText ?? "").split("\n").map((line) => `-${line}`),
      ...(edit.newText ?? "").split("\n").map((line) => `+${line}`)
    ]).join("\n");
  } catch {
    return undefined;
  }
}

export function Tool({ part }: { part: Extract<UiPart, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  if (part.name.startsWith("subagent_")) return <SubagentTool part={part} />;
  const diff = editPreview(part);
  const title = toolTitle(part);
  const bash = part.name === "bash" && part.input ? part.input : undefined;
  const hasDetails = Boolean(diff || bash || part.input || part.output);
  return (
    <div className={`tool-call rounded-xl border border-border bg-muted/35 px-4 py-3${diff ? " tool-edit" : ""}${open ? " tool-open" : ""}`}>
      <button type="button" className="tool-summary cursor-pointer font-mono text-xs font-semibold" onClick={() => setOpen((value) => !value)} aria-expanded={open} disabled={!hasDetails}>
        <span className={`tool-state tool-${part.state}`} aria-label={part.state} /><span className="tool-title" title={title}>{title}</span>
      </button>
      {/* Keep Streamdown mounted: mounting it during a Virtuoso resize can feed its passive update back into measurement. */}
      {hasDetails && <div className="tool-details" hidden={!open}>
        {diff ? <DiffView diff={diff} filePath={part.filePath} label={part.state === "running" ? "Proposed edit" : "Applied edit"} /> : bash ? <Markdown className="tool-input tool-bash-input mt-3 text-xs">{fencedCode(bash, "bash")}</Markdown> : part.input && toolCode(part.input, "tool-input tool-code-input mt-3 text-xs")}
        {!diff && part.output && toolCode(part.output, "tool-output tool-code-input mt-3 border-t border-border pt-3 text-xs")}
      </div>}
    </div>
  );
}
