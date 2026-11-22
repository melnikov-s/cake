import { Schema } from "effect";
import { ArtifactStableRef } from "../artifacts/artifact-lineage";
import { TaskInputReference } from "../conversations/task-input";
import { parseCanvasLink } from "./canvas-link";

const title = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(120));
const body = Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(2000));
const cardId = Schema.String.check(Schema.isUUID(4));
const revision = Schema.Int.check(Schema.isGreaterThan(0));
const CanvasLink = Schema.String.check(Schema.makeFilter((value) => !!parseCanvasLink(value)));
export const CanvasProject = Schema.Struct({
  projectChatId: Schema.String.check(Schema.isPattern(/^project-chat:[a-f0-9]{64}$/)),
});
const position = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export const CanvasPinInput = Schema.Struct({
  link: CanvasLink,
  x: position,
  y: position,
  text: body,
});
export interface CanvasPinInput extends Schema.Schema.Type<typeof CanvasPinInput> {}
export const CanvasPin = Schema.Struct({
  id: cardId,
  x: position,
  y: position,
  text: body,
  at: Schema.String,
});
const CanvasContent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("decision"), text: body }),
  Schema.Struct({
    kind: Schema.Literal("artifact"),
    reference: ArtifactStableRef,
    previewAttachmentId: Schema.optionalKey(TaskInputReference.fields.id),
  }),
  Schema.Struct({ kind: Schema.Literal("screenshot"), attachmentId: TaskInputReference.fields.id }),
]);
export const CanvasPublish = Schema.Struct({
  group: title,
  title,
  content: CanvasContent,
  previous: Schema.optionalKey(CanvasLink),
  aspect: Schema.optionalKey(Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 6 }))),
});
export interface CanvasPublish extends Schema.Schema.Type<typeof CanvasPublish> {}
export const CanvasRevision = Schema.Struct({
  number: revision,
  title,
  content: CanvasContent,
  publisher: Schema.NonEmptyString,
  at: Schema.String,
  aspect: Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 6 })),
  pins: Schema.Array(CanvasPin),
});
export interface CanvasRevision extends Schema.Schema.Type<typeof CanvasRevision> {}
export const CanvasCard = Schema.Struct({
  id: cardId,
  group: title,
  revisions: Schema.NonEmptyArray(CanvasRevision),
});
export interface CanvasCard extends Schema.Schema.Type<typeof CanvasCard> {}
export const CanvasSnapshot = Schema.Struct({
  version: Schema.Literal(1),
  cards: Schema.Array(CanvasCard),
});
export interface CanvasSnapshot extends Schema.Schema.Type<typeof CanvasSnapshot> {}
export const CanvasRead = Schema.Struct({ link: CanvasLink });
export const CanvasDetail = Schema.Struct({
  group: title,
  cardId,
  link: CanvasLink,
  stableLink: CanvasLink,
  revision: CanvasRevision,
  history: Schema.Array(
    Schema.Struct({
      number: revision,
      title,
      at: Schema.String,
      publisher: Schema.String,
      link: CanvasLink,
    }),
  ),
});
export const CanvasSearch = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export const CanvasResults = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      group: title,
      title,
      link: CanvasLink,
      revision,
      at: Schema.String,
      kind: Schema.Literals(["decision", "artifact", "screenshot"]),
    }),
  ),
  nextOffset: Schema.NullOr(Schema.Int),
});
export const CanvasImage = Schema.Struct({
  mimeType: Schema.Literals(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  data: Schema.String,
});
export type CanvasImage = typeof CanvasImage.Type;
export class ProjectCanvasError extends Schema.TaggedError<ProjectCanvasError>()(
  "ProjectCanvasError",
  {
    message: Schema.String,
  },
) {}
export interface ProjectCanvasControl {
  publish(input: CanvasPublish, signal: AbortSignal): Promise<typeof CanvasDetail.Type>;
  search(input: typeof CanvasSearch.Type, signal: AbortSignal): Promise<typeof CanvasResults.Type>;
  read(input: typeof CanvasRead.Type, signal: AbortSignal): Promise<typeof CanvasDetail.Type>;
}
