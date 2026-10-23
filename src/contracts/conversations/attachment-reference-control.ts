import { Schema } from "effect";
import type { CakeOperationResult } from "../agent/cake-operation";
import type { JsonValue } from "../serialization/json-contract";
import { TaskInputReference } from "./task-input";

export const AttachmentReferenceQuery = Schema.Struct({
  after: Schema.optionalKey(TaskInputReference.fields.id),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export interface AttachmentReferenceQuery extends Schema.Schema.Type<
  typeof AttachmentReferenceQuery
> {}

export const AttachmentReadInput = Schema.Struct({
  reference: TaskInputReference.fields.id,
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 48_000 }))),
});
export interface AttachmentReadInput extends Schema.Schema.Type<typeof AttachmentReadInput> {}

/** A session-scoped capability. Neither operation accepts a path or another session identity. */
export interface AttachmentReferenceControl {
  list(input: AttachmentReferenceQuery, signal: AbortSignal): Promise<JsonValue>;
  read(input: AttachmentReadInput, signal: AbortSignal): Promise<CakeOperationResult>;
}

/** Image types the attachment reader returns as pixels. */
const attachmentImageMimeTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const isAttachmentImageMimeType = (mimeType: string) =>
  attachmentImageMimeTypes.some((supported) => supported === mimeType);

export const AttachmentContent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("image"),
    reference: TaskInputReference,
    data: Schema.String.check(Schema.isMaxLength(Math.ceil(8_000_000 / 3) * 4)),
    mimeType: Schema.Literals(attachmentImageMimeTypes),
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    reference: TaskInputReference,
    text: Schema.String.check(Schema.isMaxLength(48_000)),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    totalCharacters: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  }),
]);
export type AttachmentContent = Schema.Schema.Type<typeof AttachmentContent>;
