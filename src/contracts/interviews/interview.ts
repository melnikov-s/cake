import { Predicate, Schema } from "effect";
import { jsonValueSchema, type JsonValue } from "../serialization/json-contract";
import {
  inlineWidgetLanguageSchema,
  inlineWidgetSourceSchema,
} from "../widgets/inline-widget-contract";

const maxInputBytes = 1_048_576;
const requestId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const opaqueId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));
const scalar = Schema.Union([
  Schema.String.check(Schema.isMaxLength(262_144)),
  Schema.Number.check(Schema.isFinite()),
  Schema.Boolean,
  Schema.Null,
]);

export type InterviewResponseSchema = {
  readonly type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  readonly title?: string;
  readonly description?: string;
  readonly enum?: Array<string | number | boolean | null>;
  readonly required?: Array<string>;
  readonly properties?: Readonly<Record<string, InterviewResponseSchema>>;
  readonly items?: InterviewResponseSchema;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
};
const responseSchema: Schema.Codec<InterviewResponseSchema> = Schema.suspend(() =>
  Schema.Struct({
    type: Schema.optional(
      Schema.Literals(["object", "array", "string", "number", "integer", "boolean", "null"]),
    ),
    title: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
    description: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
    enum: Schema.optional(Schema.mutable(Schema.Array(scalar)).check(Schema.isMaxLength(1_000))),
    required: Schema.optional(
      Schema.mutable(Schema.Array(Schema.String.check(Schema.isMaxLength(256)))).check(
        Schema.isMaxLength(1_000),
      ),
    ),
    properties: Schema.optional(
      Schema.Record(Schema.String.check(Schema.isMaxLength(256)), responseSchema),
    ),
    items: Schema.optional(responseSchema),
    minimum: Schema.optional(Schema.Number.check(Schema.isFinite())),
    maximum: Schema.optional(Schema.Number.check(Schema.isFinite())),
    minLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    maxLength: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(maxInputBytes)),
    ),
  }),
);

export const InterviewField = Schema.Struct({
  id: requestId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  type: Schema.Literals(["text", "textarea", "number", "checkbox", "select"]),
  placeholder: Schema.optional(Schema.String.check(Schema.isMaxLength(512))),
  options: Schema.optional(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          value: Schema.String.check(Schema.isMaxLength(256)),
          label: Schema.String.check(Schema.isMaxLength(512)),
        }),
      ),
    ).check(Schema.isMaxLength(200)),
  ),
});
export interface InterviewField extends Schema.Schema.Type<typeof InterviewField> {}

export const InterviewDefinition = Schema.Struct({
  protocol: Schema.Literal("cake.request/v1"),
  id: requestId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  responseSchema,
  view: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("form"),
      fields: Schema.mutable(Schema.Array(InterviewField)).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(200),
      ),
    }),
    Schema.Struct({
      type: Schema.Literal("widget"),
      language: inlineWidgetLanguageSchema,
      source: inlineWidgetSourceSchema,
    }),
  ]),
  fallback: Schema.Struct({
    markdown: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maxInputBytes)),
  }),
}).check(
  Schema.makeFilter((request) =>
    request.view.type === "form" &&
    request.responseSchema.type === "object" &&
    request.responseSchema.required?.length
      ? "Form fields are optional and cannot be required by the response schema"
      : undefined,
  ),
  Schema.makeFilter((request) =>
    new TextEncoder().encode(JSON.stringify(request)).byteLength > maxInputBytes
      ? "Interview input exceeds the 1 MB limit"
      : undefined,
  ),
);
export interface InterviewDefinition extends Schema.Schema.Type<typeof InterviewDefinition> {}

/** One invocation, identified by its Pi tool-call ID, independent of artifact lineages. */
export const InterviewRecord = Schema.Struct({
  id: opaqueId,
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  request: InterviewDefinition,
});
export interface InterviewRecord extends Schema.Schema.Type<typeof InterviewRecord> {}

/** Pi-owned non-context metadata preserves the interview beside its originating tool call. */
export const InterviewEntry = Schema.Struct({
  ...InterviewRecord.fields,
  origin: Schema.Struct({ assistantEntryId: opaqueId, toolCallId: opaqueId }),
});
export interface InterviewEntry extends Schema.Schema.Type<typeof InterviewEntry> {}

export const InterviewResult = Schema.Struct({
  interviewId: opaqueId,
  cancelled: Schema.Boolean,
  value: Schema.optionalKey(Schema.MutableJson),
});
export interface InterviewResult extends Schema.Schema.Type<typeof InterviewResult> {}

export const InterviewResponse = Schema.Struct({
  requestId: Schema.String.check(Schema.isUUID()),
  interviewRequestId: Schema.String.check(Schema.isUUID()),
  sessionId: InterviewRecord.fields.sessionId,
  value: Schema.optional(jsonValueSchema),
  cancelled: Schema.Boolean,
});
export interface InterviewResponse extends Schema.Schema.Type<typeof InterviewResponse> {}

export class InterviewError extends Schema.TaggedError<InterviewError>()("InterviewError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export function validateInterviewResponse(
  schema: InterviewResponseSchema,
  value: JsonValue | undefined,
): Schema.MutableJson | undefined {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxInputBytes)
    throw new Error("Interview response exceeds the size limit");
  const parsed =
    value === undefined ? undefined : Schema.decodeUnknownSync(Schema.MutableJson)(value);
  validateJsonValue(schema, parsed, "$response");
  return parsed;
}

function validateJsonValue(
  schema: InterviewResponseSchema,
  value: JsonValue | undefined,
  path: string,
): void {
  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value)))
    throw new Error(`${path} is not an allowed value`);
  if (schema.type === "null" && value !== null) throw new Error(`${path} must be null`);
  if (schema.type === "boolean" && !Predicate.isBoolean(value))
    throw new Error(`${path} must be a boolean`);
  if (
    (schema.type === "number" || schema.type === "integer") &&
    (!Predicate.isNumber(value) ||
      !Number.isFinite(value) ||
      (schema.type === "integer" && !Number.isInteger(value)))
  )
    throw new Error(`${path} must be ${schema.type}`);
  if (
    Predicate.isNumber(value) &&
    ((schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum))
  )
    throw new Error(`${path} is outside the allowed range`);
  if (schema.type === "string" && !Predicate.isString(value))
    throw new Error(`${path} must be a string`);
  if (
    Predicate.isString(value) &&
    ((schema.minLength !== undefined && value.length < schema.minLength) ||
      (schema.maxLength !== undefined && value.length > schema.maxLength))
  )
    throw new Error(`${path} has an invalid length`);
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    const items = schema.items;
    if (items) value.forEach((item, index) => validateJsonValue(items, item, `${path}[${index}]`));
  }
  if (schema.type === "object") {
    if (!Predicate.isObject(value) || Array.isArray(value))
      throw new Error(`${path} must be an object`);
    for (const key of schema.required ?? [])
      if (!(key in value)) throw new Error(`${path}.${key} is required`);
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (key in value)
        validateJsonValue(
          child,
          Schema.decodeUnknownSync(jsonValueSchema)(value[key]),
          `${path}.${key}`,
        );
  }
}
