import { Schema } from "effect";
import { ArtifactLineageId, ArtifactRevisionNumber } from "./artifact-lineage";
import { ArtifactNavigationContext } from "./artifact-navigation-context";

export const ArtifactViewReference = Schema.Struct({
  lineageId: ArtifactLineageId,
  revision: ArtifactRevisionNumber,
  surface: Schema.Literals(["inline", "pane", "fullscreen", "library"]),
});
export interface ArtifactViewReference extends Schema.Schema.Type<typeof ArtifactViewReference> {}

export const ArtifactViewingReport = Schema.Struct({
  navigation: Schema.NullOr(ArtifactNavigationContext),
  visible: Schema.Array(ArtifactViewReference).check(Schema.isMaxLength(200)),
  active: Schema.optionalKey(ArtifactViewReference),
});
export interface ArtifactViewingReport extends Schema.Schema.Type<typeof ArtifactViewingReport> {}

const ArtifactWindowViewing = Schema.Struct({
  connectionId: Schema.Int,
  ...ArtifactViewingReport.fields,
});

export const ArtifactViewing = Schema.Struct({
  windows: Schema.Array(ArtifactWindowViewing),
  callingWindow: Schema.optionalKey(Schema.Int),
});
export interface ArtifactViewing extends Schema.Schema.Type<typeof ArtifactViewing> {}
