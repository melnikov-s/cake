import { z } from "zod";
import type { ChangedFile, UiPart } from "../ipc/session-contract";

const editInputSchema = z.object({
  edits: z
    .array(z.object({ oldText: z.string().optional(), newText: z.string().optional() }))
    .optional(),
});
const writeInputSchema = z.object({
  content: z.string().optional(),
});
const toolPathInputSchema = z.object({
  path: z.string().optional(),
  file_path: z.string().optional(),
});

export type ChangeSource = "working-tree" | "conversation-turn";

export interface WorkLogTurn {
  id: string;
  label: string;
  changes: ChangedFile[];
  additions: number;
  deletions: number;
}

export function toolDiff(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.diff) return part.diff;
  try {
    const input = JSON.parse(part.input);
    if (part.name === "edit") {
      const parsed = editInputSchema.safeParse(input);
      if (!parsed.success || !parsed.data.edits?.length) return undefined;
      return parsed.data.edits
        .flatMap((edit, index) => [
          ...(index > 0 ? [`@@ change ${index + 1} @@`] : []),
          ...(edit.oldText ?? "").split("\n").map((line) => `-${line}`),
          ...(edit.newText ?? "").split("\n").map((line) => `+${line}`),
        ])
        .join("\n");
    }
    if (part.name !== "write") return undefined;
    const parsed = writeInputSchema.safeParse(input);
    if (!parsed.success || !parsed.data.content) return undefined;
    return parsed.data.content
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
  } catch {
    return undefined;
  }
}

function toolPath(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.filePath) return part.filePath;
  try {
    const parsed = toolPathInputSchema.safeParse(JSON.parse(part.input));
    if (!parsed.success) return undefined;
    return parsed.data.path ?? parsed.data.file_path;
  } catch {
    return undefined;
  }
}

function diffStats(diff: string) {
  const lines = diff.split("\n");
  return {
    additions: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
  };
}

function labelForTurn(text: string, index: number) {
  const label = text.replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 160) : `Turn ${index}`;
}

export function workLogChanges(parts: readonly UiPart[]): ChangedFile[] {
  const changes: ChangedFile[] = [];
  for (const part of parts) {
    if (part.kind !== "tool" || part.state === "error" || part.state === "denied") continue;
    const diff = toolDiff(part);
    const path = toolPath(part);
    if (!diff || !path) continue;
    const stats = diffStats(diff);
    const existing = changes.find((change) => change.path === path);
    if (existing) {
      existing.diff = `${existing.diff}\n${diff}`;
      existing.additions += stats.additions;
      existing.deletions += stats.deletions;
    } else {
      changes.push({
        path,
        status: "modified",
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
      });
    }
  }
  return changes;
}

export function workLogTurns(parts: readonly UiPart[]): WorkLogTurn[] {
  const turns: WorkLogTurn[] = [];
  let current: WorkLogTurn | undefined;
  let turnIndex = 0;

  const flush = () => {
    if (current && current.changes.length > 0) turns.push(current);
    current = undefined;
  };

  for (const part of parts) {
    if (part.kind === "text" && part.role === "user") {
      flush();
      turnIndex += 1;
      current = {
        id: `turn-${part.id}`,
        label: labelForTurn(part.text, turnIndex),
        changes: [],
        additions: 0,
        deletions: 0,
      };
      continue;
    }
    if (part.kind !== "tool" || part.state === "error" || part.state === "denied") continue;
    const diff = toolDiff(part);
    const path = toolPath(part);
    if (!diff || !path) continue;
    current ??= {
      id: `turn-${part.id}`,
      label: labelForTurn("Agent changes", ++turnIndex),
      changes: [],
      additions: 0,
      deletions: 0,
    };
    const stats = diffStats(diff);
    const existing = current.changes.find((change) => change.path === path);
    if (existing) {
      existing.diff = `${existing.diff}\n${diff}`;
      existing.additions += stats.additions;
      existing.deletions += stats.deletions;
    } else {
      current.changes.push({
        path,
        status: "modified",
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
      });
    }
    current.additions += stats.additions;
    current.deletions += stats.deletions;
  }
  flush();
  return turns;
}
