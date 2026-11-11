import { Schema } from "effect";
import { ArtifactLineageId } from "../artifacts/artifact-lineage";
import { TaskInputReference } from "../conversations/task-input";

export const WIDGET_ITEM_LABEL_MAX = 200;
const WIDGET_ITEM_ID_MAX = 256;
export const WIDGET_ITEM_DATA_MAX_BYTES = 8 * 1024;
/** Shared with every other composer attachment; annotations count as one bundle. */
export const COMPOSER_ATTACHMENT_LIMIT = 20;

const jsonBytes = (value: Schema.Json) =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

const label = Schema.Trim.check(
  Schema.isMinLength(1, { message: "label is required" }),
  Schema.isMaxLength(WIDGET_ITEM_LABEL_MAX, {
    message: `label must be at most ${WIDGET_ITEM_LABEL_MAX} characters`,
  }),
);
const itemId = Schema.String.check(
  Schema.isMinLength(1, { message: "itemId is required" }),
  Schema.isMaxLength(WIDGET_ITEM_ID_MAX, {
    message: `itemId must be at most ${WIDGET_ITEM_ID_MAX} characters`,
  }),
);
const data = Schema.Json.check(
  Schema.makeFilter(
    (value) =>
      jsonBytes(value) <= WIDGET_ITEM_DATA_MAX_BYTES ||
      `data must serialize to at most ${WIDGET_ITEM_DATA_MAX_BYTES} bytes of JSON`,
  ),
);

/** Filled by the host from the rendering widget; never read from widget input. */
export const WidgetItemOrigin = Schema.Struct({
  lineageId: ArtifactLineageId,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
});
export interface WidgetItemOrigin extends Schema.Schema.Type<typeof WidgetItemOrigin> {}

/** A widget-provided reference in a composer draft. `name` is the visible label. */
export const WidgetItemAttachment = Schema.Struct({
  kind: Schema.Literal("widget-item"),
  inputReference: Schema.optionalKey(TaskInputReference),
  name: label,
  itemId,
  data: Schema.optionalKey(data),
  widget: WidgetItemOrigin,
});
export interface WidgetItemAttachment extends Schema.Schema.Type<typeof WidgetItemAttachment> {}

/** `cake.composer.attach` input. Unknown keys, including any `widget` origin, are ignored. */
export const WidgetComposerAttachInput = Schema.Struct({
  label,
  itemId,
  data: Schema.optionalKey(data),
  sessionId: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1, { message: "sessionId must not be empty" }),
      Schema.isMaxLength(256),
    ),
  ),
});
export interface WidgetComposerAttachInput extends Schema.Schema.Type<
  typeof WidgetComposerAttachInput
> {}

/** Parses widget-supplied input at the frame boundary; failures become a result, not silence. */
export const decodeWidgetComposerAttachInput =
  Schema.decodeUnknownResult(WidgetComposerAttachInput);

export const widgetComposerInputError = (error: Schema.SchemaError): string =>
  `Invalid composer item: ${error.message.replace(/\s*\n\s*/g, " ")}`;

type WidgetComposerTargetKind = "project-session" | "project-chat" | "cake-chat";

export interface WidgetComposerTarget {
  readonly sessionId: string;
  readonly kind: WidgetComposerTargetKind;
  readonly title: string;
  readonly projectPath?: string;
  readonly projectName?: string;
  /** The chat this widget's default target resolves to right now. */
  readonly current?: boolean;
}

export type WidgetComposerAttachResult =
  | {
      readonly ok: true;
      readonly target: WidgetComposerTarget;
      /** The same widget item was already in that draft; nothing changed. */
      readonly duplicate: boolean;
      /** Nothing is ever sent by attaching. */
      readonly sent: false;
      /** The item is in the live draft but persisting it failed. */
      readonly warning?: string;
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly target?: WidgetComposerTarget;
    };
