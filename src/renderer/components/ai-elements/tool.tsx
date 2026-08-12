/* Adapted from Vercel AI Elements tool.tsx at 0c1f5e8c75273f0e95c8faa031544a8aa2bb1a5b (Apache-2.0). Uses Cake tool states. */
import type { UiPart } from "../../../ipc/session-contract";
import { DiffView } from "./diff-view";
import { Markdown } from "./markdown";

function fencedBash(command: string) {
  const longestFence = Math.max(0, ...Array.from(command.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}bash\n${command}\n${fence}`;
}

function editPreview(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.name !== "edit") return undefined;
  if (part.diff) return part.diff;
  try {
    const input = JSON.parse(part.input) as { edits?: Array<{ oldText?: string; newText?: string }> };
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
  const diff = editPreview(part);
  const title = part.name === "edit" && part.filePath ? `edit ${part.filePath}` : part.name;
  const bash = part.name === "bash" && part.input ? part.input : undefined;
  return (
    <details className={`tool-call rounded-xl border border-border bg-muted/35 px-4 py-3${diff ? " tool-edit" : ""}`} open={part.state === "error" || (part.state === "running" && Boolean(diff))}>
      <summary className="cursor-pointer font-mono text-xs font-semibold"><span className={`tool-state tool-${part.state}`} /><span className="tool-title" title={title}>{title}</span><small>{part.state}</small></summary>
      {diff ? <DiffView diff={diff} filePath={part.filePath} label={part.state === "running" ? "Proposed edit" : "Applied edit"} /> : bash ? <Markdown className="tool-input tool-bash-input mt-3 text-xs">{fencedBash(bash)}</Markdown> : part.input && <pre className="tool-input mt-3 overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">{part.input}</pre>}
      {!diff && part.output && <pre className="tool-output mt-3 overflow-x-auto whitespace-pre-wrap border-t border-border pt-3 text-xs">{part.output}</pre>}
    </details>
  );
}
