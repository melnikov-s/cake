import { Option, Schema } from "effect";
import type { UiPart } from "../ipc/session-contract";

const editInputSchema = Schema.Struct({
  edits: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        oldText: Schema.optionalKey(Schema.String),
        newText: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
const writeInputSchema = Schema.Struct({ content: Schema.optionalKey(Schema.String) });
const toolPathInputSchema = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  file_path: Schema.optionalKey(Schema.String),
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
      const parsed = Schema.decodeUnknownOption(editInputSchema)(input);
      if (Option.isNone(parsed) || !parsed.value.edits?.length) return undefined;
      return parsed.value.edits
        .flatMap((edit, index) => [
          ...(index > 0 ? [`@@ change ${index + 1} @@`] : []),
          ...(edit.oldText ?? "").split("\n").map((line) => `-${line}`),
          ...(edit.newText ?? "").split("\n").map((line) => `+${line}`),
        ])
        .join("\n");
    }
    if (part.name !== "write") return undefined;
    const parsed = Schema.decodeUnknownOption(writeInputSchema)(input);
    if (Option.isNone(parsed) || !parsed.value.content) return undefined;
    return parsed.value.content
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
    const parsed = Schema.decodeUnknownOption(toolPathInputSchema)(JSON.parse(part.input));
    return Option.isSome(parsed) ? (parsed.value.path ?? parsed.value.file_path) : undefined;
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
