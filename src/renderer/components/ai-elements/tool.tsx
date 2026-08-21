/* Adapted from Vercel AI Elements tool.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Uses Cake tool states. */
import { useState } from "react";
import { z } from "zod";
import { jsonObjectSchema, jsonValueSchema } from "../../../ipc/json-contract";
import type { ToolOutputContent, UiPart } from "../../../ipc/session-contract";
import { toolDiff } from "../../../utils/turn-diff";
import { DiffView } from "./diff-view";
import { EditorIcon } from "./editor-icon";
import { languageForSource } from "./code";
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

function toolPath(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.filePath) return part.filePath;
  const parsed = parseJson(part.input);
  const structuredResult = jsonObjectSchema.safeParse(parsed);
  if (!structuredResult.success) return undefined;
  return ["path", "file_path"]
    .map((key) => z.string().safeParse(structuredResult.data[key]))
    .find((result) => result.success)?.data;
}

function toolTitle(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.name === "edit" && part.filePath) return `edit ${part.filePath}`;

  const parsed = parseJson(part.input);
  const structuredResult = jsonObjectSchema.safeParse(parsed);
  const structured = structuredResult.success ? structuredResult.data : undefined;
  const parsedString = z.string().safeParse(parsed);
  const detail =
    part.name === "bash"
      ? part.input
      : (toolPath(part) ??
        ["command", "query", "pattern", "url"]
          .map((key) => z.string().safeParse(structured?.[key]))
          .find((result) => result.success)?.data ??
        (parsedString.success ? parsedString.data : parsed === undefined ? part.input : ""));
  const summary = oneLine(detail);
  return summary ? `${part.name} ${summary}` : part.name;
}

function toolCode(value: string, className: string) {
  const parsed = parseJson(value);
  const source = parsed === undefined ? value : JSON.stringify(parsed, null, 2);
  const language = parsed === undefined ? "text" : "json";
  return <Markdown className={className}>{fencedCode(source, language)}</Markdown>;
}

function toolText(value: string, className: string, language = "text") {
  return <Markdown className={className}>{fencedCode(value, language)}</Markdown>;
}

function toolOutputContent(
  content: readonly ToolOutputContent[],
  className: string,
  language = "text",
) {
  return content.map((item, index) =>
    item.type === "text" ? (
      <Markdown className={className} key={`text-${index}`}>
        {fencedCode(item.text, language)}
      </Markdown>
    ) : (
      <figure className="tool-output-image" key={`image-${index}`}>
        <img
          src={`data:${item.mimeType};base64,${item.data}`}
          alt={`Tool output image ${index + 1}`}
        />
      </figure>
    ),
  );
}

function toolOutput(part: Extract<UiPart, { kind: "tool" }>, className: string, language = "text") {
  if (part.outputContent && part.outputContent.length > 0)
    return toolOutputContent(part.outputContent, className, language);
  if (part.output === undefined) return null;
  return toolText(part.output, className, language);
}

function readToolCode(part: Extract<UiPart, { kind: "tool" }>) {
  const path = toolPath(part);
  return toolOutput(
    part,
    "tool-output tool-code-input tool-read-output mt-3 text-xs",
    path ? languageForSource(path) : "text",
  );
}

function editorPath(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.name !== "read" && part.name !== "write" && part.name !== "edit") return undefined;
  return toolPath(part);
}

export function Tool({
  part,
  onOpenFile,
}: {
  part: Extract<UiPart, { kind: "tool" }>;
  onOpenFile?: (path: string) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  if (part.name.startsWith("subagent_")) return <SubagentTool part={part} />;
  const diff = toolDiff(part);
  const title = toolTitle(part);
  const read = part.name === "read";
  const bash = part.name === "bash" && part.input ? part.input : undefined;
  const hasDetails = Boolean(
    diff || bash || part.input || part.output || part.outputContent?.length,
  );
  const path = onOpenFile ? editorPath(part) : undefined;
  return (
    <div
      className={`tool-call rounded-xl border border-border bg-muted/35 px-4 py-3${diff ? " tool-edit" : ""}${open ? " tool-open" : ""}`}
    >
      <div className="tool-summary-row">
        <button
          type="button"
          className="tool-summary cursor-pointer font-mono text-xs font-semibold"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          disabled={!hasDetails}
        >
          <span className={`tool-state tool-${part.state}`} aria-label={part.state} />
          <span className="tool-title" title={title}>
            {title}
          </span>
        </button>
        {path && (
          <button
            type="button"
            className="tool-editor-button"
            aria-label={`Open ${path} in editor`}
            title="Open file in editor"
            onClick={() => void onOpenFile?.(path)}
          >
            <EditorIcon />
          </button>
        )}
      </div>
      {/* Keep Streamdown mounted: mounting it during a Virtuoso resize can feed its passive update back into measurement. */}
      {hasDetails && (
        <div className="tool-details" hidden={!open}>
          {read ? (
            readToolCode(part)
          ) : diff ? (
            <DiffView
              diff={diff}
              filePath={part.filePath}
              label={part.state === "running" ? "Proposed edit" : "Applied edit"}
            />
          ) : bash ? (
            <Markdown className="tool-input tool-bash-input mt-3 text-xs">
              {fencedCode(bash, "bash")}
            </Markdown>
          ) : (
            part.input && toolCode(part.input, "tool-input tool-code-input mt-3 text-xs")
          )}
          {!diff &&
            !read &&
            toolOutput(
              part,
              "tool-output tool-code-input mt-3 border-t border-border pt-3 text-xs",
            )}
        </div>
      )}
    </div>
  );
}
