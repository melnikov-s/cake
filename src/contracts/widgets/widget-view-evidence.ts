import { Schema } from "effect";
import { ArtifactState } from "../artifacts/artifact-state";

export const INITIAL_WIDGET_PREVIEW_LABEL = "Initial state—not current interactive view";

/** Last host-observed saved state is advisory, never a serialization of local React state. */
export const WidgetViewIdentity = Schema.Struct({
  exactRef: Schema.String.check(Schema.isPattern(/^cake:\/\/artifact\/.+@r[1-9][0-9]*$/)),
  savedState: Schema.optionalKey(ArtifactState),
  localState: Schema.Literal("unavailable: widget-local interactive state is not reported"),
});
export interface WidgetViewIdentity extends Schema.Schema.Type<typeof WidgetViewIdentity> {}

export const WidgetViewCapture = Schema.Struct({
  ...WidgetViewIdentity.fields,
  provenance: Schema.Literal("live-widget-view"),
  capturedAt: Schema.String,
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
  data: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(10_666_668)),
});
export interface WidgetViewCapture extends Schema.Schema.Type<typeof WidgetViewCapture> {}

export function retainedWidgetPreviewEvidence(exactRef: string) {
  return {
    provenance: "retained-initial-state" as const,
    label: INITIAL_WIDGET_PREVIEW_LABEL,
    exactRef,
    interactiveState: "unavailable: retained preview does not track interactive selections",
  };
}
