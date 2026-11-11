import { Schema } from "effect";
import { jsonObjectSchema } from "../serialization/json-contract";
import type { CakeOperationRuntime } from "./cake-operation-context";
import type { CakeOperationOptions } from "./cake-operation-options";
import type { JsonObject, JsonValue } from "../serialization/json-contract";

export const cakeToolDescription =
  "Cake controls: {command,input}. Known commands need no discovery; {} lists topics, <topic> lists commands, <operation>.help gives inputs, .output-schema gives results. Programmatic calls return {command,result} JSON; agent text is compact. Static HTML: html.present; interactive: widgets.present; prepared skill: widgets.instantiate directly; existing: artifacts.present.";

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

export const MAX_CAKE_OPERATION_IMAGE_BYTES = 8_000_000;

export interface CakeOperationExecutionContext {
  signal: AbortSignal;
  toolCallId: string;
  onUpdate?(value: JsonValue): void;
  runtime: CakeOperationRuntime;
}

export interface CakeOperationExample {
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
type CakeOperationContent =
  | { readonly type: "text"; readonly text: string }
  | CakeOperationImageContent;

export interface CakeOperationInvocation {
  /** Programmatic result, independent of agent presentation and identifier projection. */
  readonly json: JsonValue;
  readonly text: string;
  readonly content: CakeOperationContent[];
  readonly details: JsonValue;
  readonly structuredContent: JsonValue;
}

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
  /** Live Project Session control capability required for registration. */
  requires?: keyof NonNullable<CakeOperationOptions["currentSessionControl"]>;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  inputSchema: Schema.ConstraintDecoder<Input, never>;
  /** Exact schema used in generated help when validation is delegated across a validated boundary. */
  inputJsonSchema?: JsonObject;
  /** Optional exact result schema; all programmatic results are JSON.
   * The registry also validates JSON after decoding, allowing authoritative projection
   * schemas whose optional fields include undefined in TypeScript. */
  outputSchema?: Schema.ConstraintDecoder<unknown, never>;
  /** Exact details/receipts retain canonical identities without global suffix discovery. */
  canonicalSessionIds?: boolean;
  /** Bounded multi-outcome operations must expose every outcome in model-facing text. */
  truncateResultText?: boolean;
  examples: readonly CakeOperationExample[];
  result: string;
  limitations?: readonly string[];
  available?(): boolean;
  execute(input: Input, context: CakeOperationExecutionContext): Promise<Output>;
}
