import { z } from "zod";
import type { UiPart } from "../ipc/session-contract";

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

export interface WorkLogChange {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
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

export function workLogChanges(parts: readonly UiPart[]): WorkLogChange[] {
  const changes: WorkLogChange[] = [];
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
        additions: stats.additions,
        deletions: stats.deletions,
        diff,
      });
    }
  }
  return changes;
}
