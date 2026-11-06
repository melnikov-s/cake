import { createHash } from "node:crypto";
import { Option, Schema } from "effect";
import {
  toolOutputContentArraySchema,
  type NestedToolCalls,
  type ToolOutputContent,
  type UiPart,
} from "../../../contracts/conversations/session-contract";

export function boundedProjectionKey(value: string, maximum = 256) {
  if (value.length <= maximum) return value;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 16);
  return `${value.slice(0, maximum - digest.length - 1)}:${digest}`;
}

export function formatUnknown(value: unknown, limit = 48_000) {
  let formatted: string;
  if (typeof value === "string") formatted = value;
  else {
    try {
      formatted = JSON.stringify(value, null, 2) ?? String(value ?? "");
    } catch {
      formatted = String(value);
    }
  }
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n…` : formatted;
}

export function formatToolInput(toolName: string, args: unknown) {
  if (toolName === "codemode" && typeof args === "object" && args !== null) {
    const code = Reflect.get(args, "code");
    if (typeof code === "string") return formatUnknown(code);
  }
  if (toolName === "bash" && typeof args === "object" && args !== null) {
    const command = Reflect.get(args, "command");
    if (typeof command === "string") return formatUnknown(command);
  }
  return formatUnknown(args);
}

const persistedNestedToolCallsSchema = Schema.Struct({
  calls: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isMinLength(1)),
      name: Schema.String,
      arguments: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
      argumentsBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      status: Schema.Literals(["ok", "error", "unfinished"]),
      durationMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      error: Schema.optionalKey(Schema.String),
    }),
  ).check(Schema.isMaxLength(256)),
  complete: Schema.Boolean,
});

interface NestedToolCallMetadata {
  argumentsBytes?: number;
  durationMs?: number;
  errorSummary?: string;
}

/** Pi's summary is flat beneath the model-issued parent. Do not infer a restored tree from IDs. */
export function projectNestedToolCalls(value: unknown): NestedToolCalls | undefined {
  const parsed = Schema.decodeUnknownOption(persistedNestedToolCallsSchema)(value);
  if (Option.isNone(parsed)) return undefined;
  return {
    complete: parsed.value.complete,
    calls: parsed.value.calls.map((call) => {
      const metadata: NestedToolCallMetadata = {};
      if (call.argumentsBytes !== undefined) metadata.argumentsBytes = call.argumentsBytes;
      if (call.durationMs !== undefined) metadata.durationMs = call.durationMs;
      if (call.error !== undefined) metadata.errorSummary = call.error.slice(0, 500);
      return {
        ...metadata,
        id: boundedProjectionKey(`tool-${call.id}`),
        name: call.name,
        command: call.name === "cake" ? cakeOperationCommand(call.arguments) : undefined,
        input: call.arguments === undefined ? "" : formatToolInput(call.name, call.arguments),
        inputUnavailable: call.arguments === undefined,
        filePath: toolFilePath(call.name, call.arguments),
        outputAvailability: "unavailable",
        state: call.status === "ok" ? "success" : call.status === "error" ? "error" : "interrupted",
      };
    }),
  };
}

export function shellCommandPart(input: {
  id: string;
  command: string;
  output: string;
  excludeFromContext: boolean;
  state: Extract<UiPart, { kind: "command" }>["state"];
}): Extract<UiPart, { kind: "command" }> {
  return { kind: "command", ...input };
}

function parseToolOutputContent(content: unknown) {
  const parsed = Schema.decodeUnknownOption(toolOutputContentArraySchema)(content);
  return Option.isSome(parsed) && parsed.value.length > 0 ? parsed.value : undefined;
}

export function projectToolOutputContent(content: unknown): ToolOutputContent[] | undefined {
  const parsed = parseToolOutputContent(content);
  return parsed?.some((item) => item.type !== "text") ? [...parsed] : undefined;
}

export function toolResultContent(result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  return parseToolOutputContent(Reflect.get(result, "content"));
}

export function toolResultOutputContent(result: unknown) {
  const content = toolResultContent(result);
  return content?.some((item) => item.type !== "text") ? [...content] : undefined;
}

export function formatToolResult(result: unknown) {
  const content = toolResultContent(result);
  return content ? textFromContent(content) : formatUnknown(result);
}

export function toolFilePath(_toolName: string, args: unknown) {
  if (typeof args !== "object" || args === null) return undefined;
  const path = Reflect.get(args, "path") ?? Reflect.get(args, "file_path");
  return typeof path === "string" && path.length <= 8_192 ? path : undefined;
}

export function toolResultDiff(_toolName: string, result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  const details = Reflect.get(result, "details");
  if (typeof details !== "object" || details === null) return undefined;
  const diff = Reflect.get(details, "diff") ?? Reflect.get(details, "patch");
  return typeof diff === "string" ? diff : undefined;
}

export function cakeOperationCommand(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Reflect.get(value, "command");
  if (typeof direct === "string" && direct.length <= 256) return direct;
  const details = Reflect.get(value, "details");
  if (typeof details === "object" && details !== null) {
    const command = Reflect.get(details, "command");
    if (typeof command === "string" && command.length <= 256) return command;
  }
  return undefined;
}

const projectedArtifactIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

function projectedArtifactId(value: unknown) {
  const parsed = Schema.decodeUnknownOption(projectedArtifactIdSchema)(value);
  return Option.isSome(parsed) ? parsed.value : undefined;
}

const projectedArtifactRevisionSchema = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);

export function toolArtifactRevision(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = Schema.decodeUnknownOption(projectedArtifactRevisionSchema)(
    Reflect.get(value, "artifactRevision"),
  );
  if (Option.isSome(direct)) return direct.value;
  const details = Reflect.get(value, "details");
  if (typeof details !== "object" || details === null) return undefined;
  return toolArtifactRevision(details) ?? toolArtifactRevision(Reflect.get(details, "result"));
}

export function toolArtifactId(value: unknown) {
  if (typeof value !== "object" || value === null) return undefined;
  const direct = projectedArtifactId(Reflect.get(value, "artifactId"));
  if (direct) return direct;
  const details = Reflect.get(value, "details");
  const detailedId =
    typeof details === "object" && details !== null
      ? projectedArtifactId(Reflect.get(details, "artifactId"))
      : undefined;
  if (detailedId) return detailedId;
  const result =
    typeof details === "object" && details !== null ? Reflect.get(details, "result") : undefined;
  const resultId =
    typeof result === "object" && result !== null
      ? projectedArtifactId(Reflect.get(result, "artifactId"))
      : undefined;
  if (resultId) return resultId;
  const artifact = Reflect.get(value, "artifact");
  const artifactId =
    typeof artifact === "object" && artifact !== null
      ? projectedArtifactId(Reflect.get(artifact, "id"))
      : undefined;
  // Interview request IDs are not artifact references, including while their
  // tool arguments stream before interview metadata reaches the transcript.
  return artifactId;
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (item): item is { type: "text"; text: string } =>
        typeof item === "object" &&
        item !== null &&
        Reflect.get(item, "type") === "text" &&
        typeof Reflect.get(item, "text") === "string",
    )
    .map((item) => item.text)
    .join("\n");
}
