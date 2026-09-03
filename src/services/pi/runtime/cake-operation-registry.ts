import { Schema } from "effect";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../ipc/json-contract";

const CAKE_OPERATION_PROTOCOL = "cake.operation/v1" as const;
export const cakeToolDescription =
  'Access Cake-native capabilities unavailable through files or the shell: manage sessions and context, inspect model presets, communicate with other sessions, enter and control embedded VS Code, delegate to subagents, request structured user input, create interactive visual widgets, and send notifications. Call with {} for help. For a topic protocol, set command to the exact topic name, for example {"command":"vscode"}; do not put the topic in input.';

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

export interface CakeOperationDefinition<Input = unknown, Output = JsonValue> {
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

interface CakeTopicDefinition {
  name: string;
  summary: string;
  guidance?: readonly string[];
}

const cakeTopics = [
  { name: "app", summary: "Inspect Cake application state." },
  { name: "sessions", summary: "Inspect, manage, or communicate with sessions." },
  { name: "context", summary: "Inspect context use or compact the current session." },
  { name: "models", summary: "List configured model presets." },
  { name: "requests", summary: "Collect structured user input through interactive forms." },
  { name: "widgets", summary: "Create interactive or highly visual presentations." },
  { name: "vscode", summary: "Enter and control embedded VS Code." },
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
  ): Promise<{ text: string; details: JsonValue }> {
    const envelope = Schema.decodeUnknownSync(cakeToolEnvelopeSchema)(envelopeInput);
    const command = envelope.command ?? "help";
    if (command === "help") {
      const text = this.help();
      return { text, details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: text } };
    }
    const topicHelp = this.topicHelp(command);
    if (topicHelp !== undefined) {
      return {
        text: topicHelp,
        details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: topicHelp },
      };
    }
    const operation = this.operations.get(command);
    if (!operation) {
      const text = this.unknown(command);
      return { text, details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: text } };
    }
    const input = Schema.decodeUnknownSync(operation.inputSchema, { onExcessProperty: "error" })(
      envelope.input ?? {},
    );
    const result = Schema.decodeUnknownSync(jsonValueSchema)(
      await operation.execute(input, context),
    );
    const serialized = JSON.stringify(result);
    const byteLength = new TextEncoder().encode(serialized).byteLength;
    const boundedResult: JsonValue =
      byteLength > 1_048_576
        ? {
            truncated: true,
            byteLength,
            preview: formatCakeResult(result),
          }
        : result;
    return {
      text: formatCakeResult(result),
      details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: boundedResult },
    };
  }
}

function formatCakeResult(value: JsonValue, limit = 24_000) {
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n… (truncated)` : formatted;
}
