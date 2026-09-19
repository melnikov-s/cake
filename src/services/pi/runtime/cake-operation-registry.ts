import { Schema } from "effect";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../ipc/json-contract";

const CAKE_OPERATION_PROTOCOL = "cake.operation/v1" as const;
const MAX_CAKE_OPERATION_RESULT_BYTES = 1_048_576;
export const MAX_CAKE_OPERATION_IMAGE_BYTES = 8_000_000;
const MAX_CAKE_OPERATION_IMAGES = 4;
const MAX_CAKE_OPERATION_IMAGE_BASE64_LENGTH = Math.ceil(MAX_CAKE_OPERATION_IMAGE_BYTES / 3) * 4;

export const cakeToolDescription =
  'Cake capabilities are part of the response and are progressively disclosed by topic: app, sessions, context, models, interview, artifacts, widgets, plugins, vscode, browser, draw, subagents, notifications, and worktrees. Before defaulting to prose, consider whether the request may imply a Cake interaction. If a topic seems potentially relevant—even when unsure—request it to discover its current operations, exact schemas, and examples, then use it when it better fulfills the request. Users do not need to name the tool explicitly. Call with {} for the topic index; request a topic with {"command":"<topic>"}, not in input. Artifacts are durable linked records; use artifacts.list or artifacts.search to discover them and artifacts.resolve-reference for an exact readable path. Artifact content is not automatically in context.';

const commandSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).annotate({
  description: "Exact topic or operation command. Omit for the help index.",
});
export const cakeToolEnvelopeSchema = Schema.Struct({
  command: Schema.optionalKey(commandSchema),
  input: Schema.optionalKey(
    jsonObjectSchema.annotate({
      description: "Operation arguments only. Omit for help and topic protocol discovery.",
    }),
  ),
});

export interface CakeOperationExecutionContext {
  signal: AbortSignal;
  toolCallId: string;
  onUpdate?(value: JsonValue): void;
  runtime: unknown;
}

interface CakeOperationExample {
  input?: JsonObject;
  description?: string;
}

export interface CakeOperationImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface CakeOperationImageResult {
  readonly _tag: "CakeOperationImageResult";
  /** JSON metadata shown as text and retained in tool details. Image bytes stay in content only. */
  readonly metadata: JsonValue;
  readonly images: ReadonlyArray<CakeOperationImageContent>;
}

export type CakeOperationResult = JsonValue | CakeOperationImageResult;
export type CakeOperationContent =
  | { readonly type: "text"; readonly text: string }
  | CakeOperationImageContent;

export function cakeOperationImageResult(
  metadata: JsonValue,
  images: ReadonlyArray<CakeOperationImageContent>,
): CakeOperationImageResult {
  return { _tag: "CakeOperationImageResult", metadata, images };
}

export interface CakeOperationDefinition<
  Input = unknown,
  Output extends CakeOperationResult = CakeOperationResult,
> {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  inputSchema: Schema.ConstraintDecoder<Input, never>;
  /** Exact schema used in generated help when validation is delegated across a validated boundary. */
  inputJsonSchema?: JsonObject;
  examples: readonly CakeOperationExample[];
  result: string;
  limitations?: readonly string[];
  execute(input: Input, context: CakeOperationExecutionContext): Promise<Output>;
}

const cakeOperationImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_CAKE_OPERATION_IMAGE_BASE64_LENGTH),
  ),
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/webp", "image/gif"]),
});

interface CakeTopicDefinition {
  name: string;
  summary: string;
  guidance?: readonly string[];
}

const cakeTopics = [
  { name: "app", summary: "Inspect and arrange the Cake application." },
  {
    name: "sessions",
    summary: "Create, inspect, message, steer, stop, and manage sessions.",
  },
  { name: "context", summary: "Inspect context use or compact the current session." },
  { name: "models", summary: "List configured model presets." },
  { name: "interview", summary: "Gather requirements through structured user interviews." },
  {
    name: "artifacts",
    summary: "List, search, resolve, create, revise, restore, link, and unlink artifacts.",
  },
  { name: "widgets", summary: "Create interactive or highly visual presentations." },
  {
    name: "plugins",
    summary: "Create and manage durable UI controls attached to the current session.",
  },
  {
    name: "vscode",
    summary:
      "Give code tours and walkthroughs, navigate and review source, or debug in embedded VS Code.",
  },
  {
    name: "browser",
    summary: "Open the embedded browser and control it through unrestricted raw CDP.",
  },
  {
    name: "draw",
    summary: "Open, inspect, render, and explicitly edit a session's Cake Draw board.",
  },
  { name: "subagents", summary: "Delegate explicitly requested work." },
  { name: "notifications", summary: "Notify the user." },
  { name: "worktrees", summary: "Complete an active worktree landing workflow." },
] as const satisfies readonly CakeTopicDefinition[];

function schemaJson(schema: Schema.Constraint): JsonObject {
  return Schema.decodeUnknownSync(jsonObjectSchema)(
    Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema.input({ target: "draft-07" }),
  );
}

function topicIndex(availableTopics: ReadonlySet<string>) {
  return cakeTopics
    .filter((topic) => availableTopics.has(topic.name))
    .map((topic) => `${topic.name} — ${topic.summary}`)
    .join("\n");
}

interface CakeOperationEnvelopeExample {
  command: string;
  input?: JsonObject;
}

function exampleEnvelope(command: string, example: CakeOperationExample) {
  const envelope: CakeOperationEnvelopeExample = { command };
  if (example.input) envelope.input = example.input;
  return envelope;
}

function levenshtein(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0]!;
    row[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex]!;
      row[rightIndex] = Math.min(
        row[rightIndex]! + 1,
        row[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = previous;
    }
  }
  return row[right.length]!;
}

export class CakeOperationRegistry {
  private readonly operations = new Map<string, CakeOperationDefinition>();

  constructor(definitions: readonly CakeOperationDefinition[]) {
    for (const definition of definitions) {
      if (this.operations.has(definition.command))
        throw new Error(`Duplicate Cake operation ${definition.command}`);
      if (definition.command.split(".")[0] !== definition.topic && definition.topic !== "sessions")
        throw new Error(
          `Cake operation ${definition.command} does not belong to ${definition.topic}`,
        );
      this.operations.set(definition.command, definition);
    }
  }

  definitions() {
    return [...this.operations.values()];
  }

  availableTopics() {
    return new Set(this.definitions().map((definition) => definition.topic));
  }

  help() {
    return topicIndex(this.availableTopics());
  }

  completeHelp() {
    return [...this.availableTopics()]
      .sort()
      .flatMap((topic) => {
        const help = this.topicHelp(topic);
        return help ? [help] : [];
      })
      .join("\n\n");
  }

  topicHelp(topic: string) {
    const operations = this.definitions().filter((definition) => definition.topic === topic);
    if (operations.length === 0) return undefined;
    const topicDefinition = cakeTopics.find((candidate) => candidate.name === topic);
    return [
      `${topic} — ${topicDefinition?.summary ?? "Cake operations."}`,
      ...[...new Set(operations.flatMap((operation) => operation.guidance ?? []))].map(
        (line) => `- ${line}`,
      ),
      ...operations.flatMap((operation) => [
        `\n${operation.command} — ${operation.summary}`,
        `Input schema:\n${JSON.stringify(operation.inputJsonSchema ?? schemaJson(operation.inputSchema), null, 2)}`,
        `Result: ${operation.result}`,
        ...(operation.limitations ?? []).map((line) => `Limitation: ${line}`),
        ...(operation.examples.length
          ? [
              `Example:\n${JSON.stringify(
                exampleEnvelope(operation.command, operation.examples[0]!),
                null,
                2,
              )}`,
            ]
          : []),
      ]),
    ].join("\n");
  }

  unknown(command: string) {
    const candidates = [...this.availableTopics(), ...this.operations.keys(), "help"].sort(
      (left, right) => {
        const distance = levenshtein(command, left) - levenshtein(command, right);
        return distance || left.localeCompare(right);
      },
    );
    return `Unknown Cake command: ${command}\nNearest matches: ${candidates.slice(0, 3).join(", ")}\n\n${this.help()}`;
  }

  async invoke(
    envelopeInput: unknown,
    context: CakeOperationExecutionContext,
  ): Promise<{ text: string; content: CakeOperationContent[]; details: JsonValue }> {
    const envelope = Schema.decodeUnknownSync(cakeToolEnvelopeSchema)(envelopeInput);
    const command = envelope.command ?? "help";
    if (command === "help") return helpResult(command, this.help());
    const topicHelp = this.topicHelp(command);
    if (topicHelp !== undefined) return helpResult(command, topicHelp);
    const operation = this.operations.get(command);
    if (!operation) return helpResult(command, this.unknown(command));
    const input = Schema.decodeUnknownSync(operation.inputSchema, { onExcessProperty: "error" })(
      envelope.input ?? {},
    );
    const executionResult = await operation.execute(input, context);
    const richResult = isCakeOperationImageResult(executionResult);
    const result = Schema.decodeUnknownSync(jsonValueSchema)(
      richResult ? executionResult.metadata : executionResult,
    );
    const images = richResult ? decodeImages(executionResult.images) : [];
    const serialized = JSON.stringify(result);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    const boundedResult: JsonValue =
      byteLength > MAX_CAKE_OPERATION_RESULT_BYTES
        ? {
            truncated: true,
            byteLength,
            preview: formatCakeResult(result),
          }
        : result;
    const text = formatCakeResult(result);
    return {
      text,
      content: [{ type: "text", text }, ...images],
      details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: boundedResult },
    };
  }
}

function helpResult(command: string, text: string) {
  return {
    text,
    content: [{ type: "text" as const, text }],
    details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: text },
  };
}

function isCakeOperationImageResult(value: CakeOperationResult): value is CakeOperationImageResult {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "_tag" in value &&
    value._tag === "CakeOperationImageResult"
  );
}

function decodeImages(images: ReadonlyArray<CakeOperationImageContent>) {
  if (images.length === 0) throw new Error("Cake image operation results require an image");
  if (images.length > MAX_CAKE_OPERATION_IMAGES)
    throw new Error(`Cake operation results support at most ${MAX_CAKE_OPERATION_IMAGES} images`);
  const decoded = images.map((image) => {
    const parsed = Schema.decodeUnknownSync(cakeOperationImageSchema, {
      onExcessProperty: "error",
    })(image);
    if (!isBase64(parsed.data)) throw new Error("Cake operation result image data is not base64");
    return parsed;
  });
  const totalBytes = decoded.reduce((total, image) => total + base64ByteLength(image.data), 0);
  if (totalBytes > MAX_CAKE_OPERATION_IMAGE_BYTES)
    throw new Error(
      `Cake operation result images exceed the ${MAX_CAKE_OPERATION_IMAGE_BYTES}-byte limit`,
    );
  return decoded;
}

function isBase64(value: string) {
  if (value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  return true;
}

function base64ByteLength(value: string) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function formatCakeResult(value: JsonValue, limit = 24_000) {
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n… (truncated)` : formatted;
}
