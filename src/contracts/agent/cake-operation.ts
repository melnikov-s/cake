import type { Schema } from "effect";
import type { CakeOperationRuntime } from "./cake-operation-context";
import type { CakeOperationOptions } from "./cake-operation-options";
import type { JsonObject, JsonValue } from "../serialization/json-contract";

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
  /** Live Project Session control capability required for registration. */
  requires?: keyof NonNullable<CakeOperationOptions["currentSessionControl"]>;
  topic: string;
  summary: string;
  guidance?: readonly string[];
  inputSchema: Schema.ConstraintDecoder<Input, never>;
  /** Exact schema used in generated help when validation is delegated across a validated boundary. */
  inputJsonSchema?: JsonObject;
  /** Opt into validated data for codemode; other operations continue to resolve to text.
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
