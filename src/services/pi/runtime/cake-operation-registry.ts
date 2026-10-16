import { Schema } from "effect";
import {
  MAX_CAKE_OPERATION_IMAGE_BYTES,
  type CakeOperationContent,
  type CakeOperationDefinition,
  type CakeOperationExample,
  type CakeOperationExecutionContext,
  type CakeOperationImageContent,
  type CakeOperationImageResult,
  type CakeOperationResult,
} from "../../../contracts/agent/cake-operation";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../contracts/serialization/json-contract";
import {
  cakeOperationAliasHelp,
  cakeOperationExpectedFields,
  normalizeCakeOperationInput,
} from "./cake-operation-input";

const CAKE_OPERATION_PROTOCOL = "cake.operation/v1" as const;
const MAX_CAKE_OPERATION_RESULT_BYTES = 1_048_576;
const MAX_CAKE_OPERATION_IMAGES = 4;
const MAX_CAKE_OPERATION_IMAGE_BASE64_LENGTH = Math.ceil(MAX_CAKE_OPERATION_IMAGE_BYTES / 3) * 4;

export const cakeToolDescription =
  'Cake capabilities are part of the response and are progressively disclosed by topic: app, projects, sessions, attachments, messages, context, models, settings, interview, artifacts, boards, widgets, plugins, vscode, browser, subagents, notifications, and worktrees. The help index reflects currently enabled capabilities; experimental features are unavailable unless enabled in Settings. Before defaulting to prose, consider whether the request may imply a Cake interaction. If a topic seems potentially relevant—even when unsure—request it to discover its current operations, exact schemas, and examples, then use it when it better fulfills the request. Users do not need to name the tool explicitly. Call with {} for the topic index; request a topic with {"command":"<topic>"}, not in input. Request one exact operation schema with {"command":"<operation>.help"}. Artifacts are durable linked records; use artifacts.list or artifacts.search to discover them and artifacts.resolve-reference for an exact readable path. Artifact content is not automatically in context. Use artifacts.present to show an existing linked artifact again inline without regeneration.';

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
    name: "projects",
    summary: "List, register (add), rename, and remove the Projects in Cake's sidebar.",
  },
  {
    name: "sessions",
    summary: "Create, inspect, message, steer, stop, and manage sessions.",
    guidance: [
      "Target sessions by full UUID or s:<at least 8 trailing hex characters>. Emitted references use the shortest unique suffix (normally 8); unknown or ambiguous references fail before routing. Titles are labels, not routing identities.",
    ],
  },
  {
    name: "attachments",
    summary:
      "Discover, forward without reading, or explicitly inspect exact attachment references.",
  },
  { name: "messages", summary: "Discover, read and navigate exact Pi message references." },
  { name: "context", summary: "Inspect context use or compact the current session." },
  { name: "models", summary: "List configured model presets." },
  {
    name: "settings",
    summary: "Inspect and configure Cake/Pi Settings through their existing authorities.",
  },
  { name: "interview", summary: "Gather requirements through structured user interviews." },
  {
    name: "artifacts",
    summary: "List, search, resolve, create, revise, restore, link, and unlink artifacts.",
  },
  {
    name: "boards",
    summary:
      "Coordinate through targeted Workboard entries, current decisions and selective reads.",
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
  { name: "subagents", summary: "Delegate explicitly requested work." },
  {
    name: "workflows",
    summary:
      "Offer an interactive execution choice, or run explicitly requested Project-owned script orchestration.",
  },
  { name: "notifications", summary: "Notify the user." },
  {
    name: "worktrees",
    summary:
      "Land (merge) Cake-managed worktrees through Cake's native landing flow, or complete an active landing.",
  },
] as const satisfies readonly CakeTopicDefinition[];

function schemaJson(
  schema: Schema.Constraint,
  direction: "input" | "output" = "input",
): JsonObject {
  return Schema.decodeUnknownSync(jsonObjectSchema)(
    Schema.toStandardJSONSchemaV1(schema)["~standard"].jsonSchema[direction]({
      target: "draft-07",
    }),
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

function inputJson(operation: CakeOperationDefinition) {
  return operation.inputJsonSchema ?? schemaJson(operation.inputSchema);
}

function aliasHelp(operation: CakeOperationDefinition) {
  const help = cakeOperationAliasHelp(inputJson(operation));
  return help ? [`Aliases: ${help}`] : [];
}

export class CakeOperationRegistry {
  private readonly operations = new Map<string, CakeOperationDefinition>();

  constructor(
    definitions: readonly CakeOperationDefinition[],
    private readonly projectResult?: (value: JsonValue, signal: AbortSignal) => Promise<JsonValue>,
  ) {
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
    return [...this.operations.values()].filter((operation) => operation.available?.() !== false);
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

  /** One tool-wide union: text for ordinary commands, command-tagged data for opted-in results. */
  outputSchema() {
    return Schema.Union([
      Schema.String,
      ...this.definitions().flatMap((operation) =>
        operation.outputSchema
          ? [
              Schema.Struct({
                command: Schema.Literal(operation.command),
                result: operation.outputSchema,
              }),
            ]
          : [],
      ),
    ]);
  }

  operationHelp(command: string) {
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false) return undefined;
    return [
      `${operation.command} — ${operation.summary}`,
      ...(operation.guidance ?? []).map((line) => `Guidance: ${line}`),
      `Input schema:\n${JSON.stringify(inputJson(operation))}`,
      ...aliasHelp(operation),
      `Result: ${operation.result}`,
      ...structuredOutputHelp(operation),
      ...(operation.limitations ?? []).map((line) => `Limitation: ${line}`),
      ...operation.examples
        .slice(0, 1)
        .map(
          (example) => `Example:\n${JSON.stringify(exampleEnvelope(operation.command, example))}`,
        ),
    ].join("\n");
  }

  topicHelp(topic: string) {
    const operations = this.definitions().filter((definition) => definition.topic === topic);
    if (operations.length === 0) return undefined;
    const topicDefinition: CakeTopicDefinition | undefined = cakeTopics.find(
      (candidate) => candidate.name === topic,
    );
    const guidance = [
      ...new Set([
        ...(topicDefinition?.guidance ?? []),
        ...operations.flatMap((operation) => operation.guidance ?? []),
      ]),
    ];
    return [
      `${topic} — ${topicDefinition?.summary ?? "Cake operations."}`,
      ...guidance.map((line) => `- ${line}`),
      ...operations.flatMap((operation) => [
        `\n${operation.command} — ${operation.summary}`,
        `Input schema:\n${JSON.stringify(inputJson(operation), null, 2)}`,
        ...aliasHelp(operation),
        `Result: ${operation.result}`,
        ...structuredOutputHelp(operation),
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
    const candidates = [
      ...this.availableTopics(),
      ...this.definitions().map((operation) => operation.command),
      "help",
    ].sort((left, right) => {
      const distance = levenshtein(command, left) - levenshtein(command, right);
      return distance || left.localeCompare(right);
    });
    return `Unknown Cake command: ${command}\nNearest matches: ${candidates.slice(0, 3).join(", ")}\n\n${this.help()}`;
  }

  async invoke(
    envelopeInput: unknown,
    context: CakeOperationExecutionContext,
  ): Promise<{
    text: string;
    content: CakeOperationContent[];
    details: JsonValue;
    structuredContent: JsonValue;
  }> {
    const envelope = Schema.decodeUnknownSync(cakeToolEnvelopeSchema)(envelopeInput);
    const command = envelope.command ?? "help";
    if (command === "help") return helpResult(command, this.help());
    const topicHelp = this.topicHelp(command);
    if (topicHelp !== undefined) return helpResult(command, topicHelp);
    if (command.endsWith(".help")) {
      const help = this.operationHelp(command.slice(0, -5));
      if (help) return helpResult(command, help);
    }
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false)
      return helpResult(command, this.unknown(command));
    const input = decodeOperationInput(operation, envelope.input ?? {});
    const executionResult = await operation.execute(input, context);
    const richResult = isCakeOperationImageResult(executionResult);
    if (operation.outputSchema && richResult)
      throw new Error(`Structured Cake operation ${command} cannot return image content`);
    const result = Schema.decodeUnknownSync(jsonValueSchema)(
      operation.outputSchema
        ? Schema.decodeUnknownSync(operation.outputSchema, { onExcessProperty: "error" })(
            executionResult,
          )
        : richResult
          ? executionResult.metadata
          : executionResult,
    );
    const presented = this.projectResult
      ? await this.projectResult(result, context.signal)
      : result;
    // Typed results retain their canonical contract. Text is always the agent projection.
    const structured =
      operation.outputSchema && !Schema.is(operation.outputSchema)(presented) ? result : presented;
    const images = richResult ? decodeImages(executionResult.images) : [];
    const serialized = JSON.stringify(structured);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    if (operation.outputSchema && byteLength > MAX_CAKE_OPERATION_RESULT_BYTES)
      throw new Error(
        `Structured Cake operation ${command} exceeds the ${MAX_CAKE_OPERATION_RESULT_BYTES}-byte result limit`,
      );
    const boundedResult: JsonValue =
      byteLength > MAX_CAKE_OPERATION_RESULT_BYTES
        ? {
            truncated: true,
            byteLength,
            preview: formatCakeResult(presented),
          }
        : structured;
    const text = formatCakeResult(
      presented,
      operation.truncateResultText === false ? MAX_CAKE_OPERATION_RESULT_BYTES : undefined,
    );
    return {
      text,
      content: [{ type: "text", text }, ...images],
      details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: boundedResult },
      structuredContent: operation.outputSchema ? { command, result: structured } : text,
    };
  }
}

/** Aliases and unknown fields are handled first so a wrong guess names the expected field. */
function decodeOperationInput(operation: CakeOperationDefinition, raw: JsonObject) {
  const schema = inputJson(operation);
  const normalized = normalizeCakeOperationInput(operation.command, raw, schema);
  try {
    return Schema.decodeUnknownSync(operation.inputSchema, { onExcessProperty: "error" })(
      normalized,
    );
  } catch (error) {
    const fields = cakeOperationExpectedFields(schema);
    throw new Error(
      [
        `Invalid ${operation.command} input: ${error instanceof Error ? error.message : String(error)}`,
        ...(fields ? [`Expected fields: ${fields}.`] : []),
        `Request {"command":"${operation.command}.help"} for the exact schema.`,
      ].join("\n"),
      { cause: error },
    );
  }
}

function structuredOutputHelp(operation: CakeOperationDefinition) {
  return operation.outputSchema
    ? [
        `Output schema (result):\n${JSON.stringify(schemaJson(operation.outputSchema, "output"))}`,
        `Codemode: tools.cake resolves to { command: ${JSON.stringify(operation.command)}, result: <validated output> }. Help and operations without an output schema resolve to text.`,
      ]
    : [];
}

function helpResult(command: string, text: string) {
  return {
    text,
    content: [{ type: "text" as const, text }],
    details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: text },
    structuredContent: text,
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
