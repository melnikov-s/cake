import { z } from "zod";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../ipc/json-contract";

export const CAKE_OPERATION_PROTOCOL = "cake.operation/v1" as const;
export const cakeToolDescription =
  "Access Cake-native capabilities unavailable through files or the shell: manage sessions and context, communicate with other sessions, delegate to subagents, request structured user input, create interactive visual widgets, manage customizations, and send notifications. Call without a command for help or with a topic for its protocol.";

export const cakeToolEnvelopeSchema = z
  .object({
    command: z.string().min(1).max(256).optional(),
    input: jsonObjectSchema.optional(),
  })
  .strict();

export interface CakeOperationExecutionContext {
  signal: AbortSignal;
  toolCallId: string;
  onUpdate?(value: JsonValue): void;
  runtime: unknown;
}

export interface CakeOperationExample {
  input?: JsonObject;
  description?: string;
}

export interface CakeOperationDefinition<Input = unknown, Output = JsonValue> {
  command: string;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  inputSchema: z.ZodType<Input>;
  /** Exact schema used in generated help when validation is delegated across a validated boundary. */
  inputJsonSchema?: JsonObject;
  examples: readonly CakeOperationExample[];
  result: string;
  limitations?: readonly string[];
  execute(input: Input, context: CakeOperationExecutionContext): Promise<Output>;
}

export interface CakeTopicDefinition {
  name: string;
  summary: string;
  guidance?: readonly string[];
}

export const cakeTopics = [
  { name: "app", summary: "Inspect Cake application state." },
  { name: "sessions", summary: "Inspect, manage, or communicate with sessions." },
  { name: "context", summary: "Inspect context use or compact the current session." },
  { name: "requests", summary: "Collect structured user input through interactive forms." },
  { name: "widgets", summary: "Create interactive or highly visual presentations." },
  { name: "subagents", summary: "Delegate explicitly requested work." },
  { name: "notifications", summary: "Notify the user." },
  { name: "customizations", summary: "Inspect or modify Cake plugins and scenes." },
] as const satisfies readonly CakeTopicDefinition[];

function schemaJson(schema: z.ZodType) {
  return jsonObjectSchema.parse(z.toJSONSchema(schema, { io: "input", target: "draft-7" }));
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
    const envelope = cakeToolEnvelopeSchema.parse(envelopeInput);
    const command = envelope.command ?? "help";
    if (command === "help") {
      if (envelope.input !== undefined) throw new Error("Cake help does not accept input");
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
    const input = operation.inputSchema.parse(envelope.input ?? {});
    const rawResult = await operation.execute(input, context);
    const result = jsonValueSchema.parse(rawResult);
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

export function formatCakeResult(value: JsonValue, limit = 24_000) {
  const formatted = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return formatted.length > limit ? `${formatted.slice(0, limit)}\n… (truncated)` : formatted;
}
