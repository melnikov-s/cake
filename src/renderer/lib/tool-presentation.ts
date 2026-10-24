import { Option, Predicate, Schema } from "effect";
import { jsonObjectSchema, jsonValueSchema } from "../../contracts/serialization/json-contract";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { toolOperationName } from "../../utils/cake-tool";
import { toWorkspaceRelativePath } from "../../utils/workspace-relative-path";
import { toHomeRelativePath } from "../../utils/home-relative-path";

export function parseToolInput(value: string) {
  try {
    return Schema.decodeUnknownSync(jsonValueSchema)(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function toolPath(part: Extract<UiPart, { kind: "tool" }>) {
  if (part.filePath) return part.filePath;
  const parsed = parseToolInput(part.input);
  const structuredResult = Schema.decodeUnknownOption(jsonObjectSchema)(parsed);
  if (Option.isNone(structuredResult)) return undefined;
  return ["path", "file_path"].map((key) => structuredResult.value[key]).find(Predicate.isString);
}

export function toolDisplayTitle(
  part: Extract<UiPart, { kind: "tool" }>,
  concise = false,
  workspacePath?: string,
  homeDirectory?: string,
) {
  const operationName = toolOperationName(part);
  if (part.name === "codemode") return operationName;
  const filePath = toolPath(part);
  const displayPath = filePath
    ? toHomeRelativePath(toWorkspaceRelativePath(filePath, workspacePath), homeDirectory)
    : undefined;
  if (concise && filePath) return operationName;
  if (operationName === "edit" && displayPath) return `edit ${displayPath}`;

  const parsed = parseToolInput(part.input);
  const structuredResult = Schema.decodeUnknownOption(jsonObjectSchema)(parsed);
  const structured = Option.isSome(structuredResult) ? structuredResult.value : undefined;
  const detail =
    operationName === "bash"
      ? part.input
      : (displayPath ??
        (part.name === "cake"
          ? undefined
          : ["command", "query", "pattern", "url"]
              .map((key) => structured?.[key])
              .find(Predicate.isString)) ??
        (Predicate.isString(parsed) ? parsed : parsed === undefined ? part.input : ""));
  const summary = detail.replace(/\s+/g, " ").trim();
  return summary ? `${operationName} ${summary}` : operationName;
}
