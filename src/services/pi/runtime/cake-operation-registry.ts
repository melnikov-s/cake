import { Schema } from "effect";
import { cakeToolCallKey } from "./cake-tool-timing";
import { withCakeOperationDeadline } from "./cake-operation-deadline";
import { discoveryResultText } from "../../../contracts/agent/discovery-result-text";
import {
  MAX_CAKE_OPERATION_IMAGE_BYTES,
  cakeToolEnvelopeSchema,
  type CakeOperationInvocation,
  type CakeOperationDefinition,
  type CakeOperationExample,
  type CakeOperationExecutionContext,
  type CakeOperationImageContent,
  type CakeOperationImageResult,
  type CakeOperationResult,
} from "../../../contracts/agent/cake-operation";
import {
  toDraft07JsonSchema,
  jsonObjectSchema,
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../../contracts/serialization/json-contract";
import { compactOperationInput } from "./cake-operation-reference";
import {
  cakeOperationAliasHelp,
  cakeOperationExpectedFields,
  normalizeCakeOperationInput,
} from "./cake-operation-input";

const CAKE_OPERATION_PROTOCOL = "cake.operation/v1" as const;
const MAX_CAKE_OPERATION_RESULT_BYTES = 1_048_576;
const MAX_CAKE_OPERATION_IMAGES = 4;
const MAX_CAKE_OPERATION_IMAGE_BASE64_LENGTH = Math.ceil(MAX_CAKE_OPERATION_IMAGE_BYTES / 3) * 4;

/** Model-facing envelope only; exact result schemas are validated in invoke and disclosed by help. */
export const cakeToolOutputSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    command: Schema.String,
    result: Schema.Unknown,
    warning: Schema.optionalKey(Schema.String),
  }),
]);

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
  guide?: string;
}

const cakeTopics = [
  {
    name: "app",
    summary: "Window and navigation",
    guide: "application.md",
  },
  {
    name: "automations",
    summary: "Saved background tasks",
  },
  {
    name: "memory",
    summary: "Shared automation notes",
  },
  {
    name: "projects",
    summary: "Registered projects",
    guide: "application.md",
  },
  {
    name: "sessions",
    summary: "Sessions, messages and lifecycle",
    guide: "sessions.md",
  },
  {
    name: "attachments",
    summary: "Shared inputs",
    guide: "session-history.md",
  },
  {
    name: "messages",
    summary: "Exact transcript messages",
    guide: "session-history.md",
  },
  {
    name: "todos",
    summary: "Ongoing work",
    guide: "chat-todos.md",
  },
  {
    name: "context",
    summary: "Context and compaction",
    guide: "session-history.md",
  },
  {
    name: "models",
    summary: "Models and presets",
    guide: "models.md",
  },
  {
    name: "session-labels",
    summary: "Session labels",
  },
  {
    name: "settings",
    summary: "Settings and instructions",
    guide: "settings.md",
  },
  {
    name: "themes",
    summary: "Color themes",
    guide: "settings-themes.md",
  },
  {
    name: "interview",
    summary: "Structured questions",
    guide: "interactions.md",
  },
  {
    name: "artifacts",
    summary: "Documents and executable widgets",
    guide: "artifacts.md",
  },
  {
    name: "boards",
    summary: "Family Workboard",
    guide: "family-coordination.md",
  },
  {
    name: "widgets",
    summary: "Interactive output",
    guide: "interactions.md",
  },
  {
    name: "plugins",
    summary: "Session controls",
    guide: "widget-authoring.md",
  },
  {
    name: "vscode",
    summary: "Code tours and debugging",
  },
  {
    name: "browser",
    summary: "Browser and CDP",
  },
  {
    name: "subagents",
    summary: "Private workers",
    guide: "delegation.md",
  },
  {
    name: "notifications",
    summary: "System notifications",
  },
  {
    name: "worktrees",
    summary: "Managed landing",
    guide: "family-lifecycle.md",
  },
] as const satisfies readonly CakeTopicDefinition[];

function schemaJson(
  schema: Schema.Constraint,
  direction: "input" | "output" = "input",
): JsonObject {
  return Schema.decodeUnknownSync(jsonObjectSchema)(
    toDraft07JsonSchema(direction === "output" ? Schema.toType(schema) : schema),
  );
}

function topicIndex(availableTopics: ReadonlySet<string>) {
  return cakeTopics
    .filter((topic) => availableTopics.has(topic.name))
    .map((topic) => `${topic.name} — ${topic.summary}`)
    .join("\n");
}

function formatExample(command: string, example: CakeOperationExample) {
  return `Example:\n${JSON.stringify({ command, input: example.input })}`;
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

  operationHelp(command: string) {
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false) return undefined;
    return [
      `${operation.command} — ${operation.summary}`,
      ...(operation.guidance ?? []).map((line) => `Guidance: ${line}`),
      `Input schema:\n${JSON.stringify(inputJson(operation))}`,
      ...aliasHelp(operation),
      `Result: ${operation.result}`,
      ...operation.examples.slice(0, 1).map((example) => formatExample(operation.command, example)),
      ...(operation.outputSchema ? [`Result schema: ${operation.command}.output-schema`] : []),
      "Limitation: Cake calls have a 5-minute maximum wait, including blocking/user-input calls. Timeout does not imply rollback; inspect state before retrying. Background work continues after its launch receipt.",
      ...(operation.limitations ?? []).map((line) => `Limitation: ${line}`),
    ].join("\n");
  }

  /** Common arguments only, projected from the same contract as help and invocation. */
  operationReference(
    command: string,
    commonFields: readonly string[] = [],
    expand: readonly string[] = [],
  ) {
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false) return undefined;
    return `${command} ${compactOperationInput(inputJson(operation), commonFields, expand)}`;
  }

  topicHelp(topic: string) {
    const operations = this.definitions().filter((definition) => definition.topic === topic);
    if (operations.length === 0) return undefined;
    const topicDefinition: CakeTopicDefinition | undefined = cakeTopics.find(
      (candidate) => candidate.name === topic,
    );
    return [
      `${topic} — ${topicDefinition?.summary ?? "Cake operations."}`,
      ...operations.map((operation) => `${operation.command} — ${operation.summary}`),
      ...(topicDefinition?.guide
        ? [`Guide: ${topicDefinition.guide} (Cake task-guide directory; relevant sections only).`]
        : []),
      "<operation>.help: contract and example; .output-schema: full result schema.",
    ].join("\n");
  }

  operationOutputSchema(command: string) {
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false) return undefined;
    return operation.outputSchema
      ? `Output schema (result):\n${JSON.stringify(schemaJson(operation.outputSchema, "output"))}`
      : `${command} returns JSON; no exact result schema is declared.`;
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
  ): Promise<CakeOperationInvocation> {
    const envelope = Schema.decodeUnknownSync(cakeToolEnvelopeSchema)(envelopeInput);
    const command = envelope.command ?? "help";
    let acceptingUpdates = true;
    try {
      return await withCakeOperationDeadline(command, context.signal, (signal) => {
        const boundedContext = { ...context, signal };
        if (context.onUpdate)
          boundedContext.onUpdate = (value) => {
            if (acceptingUpdates && !signal.aborted) context.onUpdate?.(value);
          };
        return this.dispatch(command, envelope.input ?? {}, boundedContext);
      });
    } finally {
      acceptingUpdates = false;
    }
  }

  private async dispatch(
    command: string,
    rawInput: JsonObject,
    context: CakeOperationExecutionContext,
  ): Promise<CakeOperationInvocation> {
    if (command === "help") return helpResult(command, this.help());
    const topicHelp = this.topicHelp(command);
    if (topicHelp !== undefined) return helpResult(command, topicHelp);
    if (command.endsWith(".help")) {
      const help = this.operationHelp(command.slice(0, -5));
      if (help) return helpResult(command, help);
    }
    if (command.endsWith(".output-schema")) {
      const schema = this.operationOutputSchema(command.slice(0, -14));
      if (schema !== undefined) return helpResult(command, schema);
    }
    const operation = this.operations.get(command);
    if (!operation || operation.available?.() === false)
      return helpResult(command, this.unknown(command));
    // This boundary excludes model generation, SDK admission/environment acquisition and
    // result settlement/delivery. Do not present these spans as end-to-end tool timing.
    const startedAt = performance.now();
    type Phase = "input" | "execute" | "validate" | "project" | "format";
    let phase: Phase = "input";
    let phaseStartedAt = startedAt;
    let completed = false;
    const phases: Partial<Record<Phase, number>> = {};
    const enter = (next: Phase) => {
      const now = performance.now();
      phases[phase] = now - phaseStartedAt;
      phaseStartedAt = now;
      phase = next;
    };
    try {
      const input = decodeOperationInput(operation, rawInput);
      enter("execute");
      const executionResult = await operation.execute(input, context);
      context.signal.throwIfAborted();
      enter("validate");
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
      enter("project");
      const presented =
        this.projectResult && !operation.canonicalSessionIds
          ? await this.projectResult(result, context.signal)
          : result;
      context.signal.throwIfAborted();
      enter("format");
      // Typed results retain their canonical contract. Text is always the agent projection.
      const structured =
        operation.outputSchema && !Schema.is(operation.outputSchema)(presented)
          ? result
          : presented;
      const images = richResult ? decodeImages(executionResult.images) : [];
      const serialized = JSON.stringify(structured);
      const byteLength = new TextEncoder().encode(serialized).byteLength;
      const canonicalByteLength = new TextEncoder().encode(JSON.stringify(result)).byteLength;
      if (
        operation.outputSchema &&
        Math.max(byteLength, canonicalByteLength) > MAX_CAKE_OPERATION_RESULT_BYTES
      )
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
      const programmaticResult: JsonValue =
        canonicalByteLength > MAX_CAKE_OPERATION_RESULT_BYTES
          ? {
              truncated: true,
              byteLength: canonicalByteLength,
              guidance:
                "Narrow the query or use pagination or an exact-item read for complete data.",
            }
          : result;
      const text = formatCakeResult(
        presented,
        operation.truncateResultText === false ? MAX_CAKE_OPERATION_RESULT_BYTES : undefined,
        discoveryResultText(command, presented),
      );
      completed = true;
      return {
        json: programmaticResult,
        text,
        content: [{ type: "text", text }, ...images],
        details: { protocol: CAKE_OPERATION_PROTOCOL, command, result: boundedResult },
        structuredContent: richResult
          ? {
              command,
              result: programmaticResult,
              warning:
                "Native image pixels were NOT forwarded. Descriptions and source are not image inspection. Call cake directly (outside codemode) to receive the images, or use an image-capable read on the resolved file.",
            }
          : { command, result: programmaticResult },
      };
    } finally {
      const finishedAt = performance.now();
      phases[phase] = finishedAt - phaseStartedAt;
      if (finishedAt - startedAt >= 1_000)
        // One bounded, metadata-only diagnostic per slow invocation. Never log inputs,
        // results, exceptions, tool-call/session IDs, titles, paths or arbitrary commands.
        console.warn("Slow Cake operation", {
          command: operation.command,
          call: cakeToolCallKey(context.toolCallId),
          completed,
          phase,
          phasesMs: phases,
          totalMs: finishedAt - startedAt,
        });
    }
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

function helpResult(command: string, text: string) {
  return {
    json: text,
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

function formatCakeResult(value: JsonValue, limit = 24_000, presentation?: string) {
  const formatted =
    presentation ?? (typeof value === "string" ? value : JSON.stringify(value, null, 2));
  if (formatted.length <= limit) return formatted;
  if (typeof value === "string") return `${formatted.slice(0, limit)}\n… (truncated)`;
  const compact = JSON.stringify(value);
  if (compact.length <= limit) return compact;
  return JSON.stringify({
    truncated: true,
    characterLength: formatted.length,
    preview: formatted.slice(0, 2_000),
    guidance: "Narrow the query or use pagination or an exact-item read for complete data.",
  });
}
