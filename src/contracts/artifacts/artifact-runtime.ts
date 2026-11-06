import { Schema } from "effect";
import { ArtifactLineageId } from "./artifact-lineage";
import type { ArtifactRuntimeDescriptor } from "./artifact-runtime-descriptor";

export const ArtifactRuntimeLifecycle = Schema.Literals([
  "start",
  "focus",
  "blur",
  "unmount",
  "stop",
  "delete",
]);
export type ArtifactRuntimeLifecycle = typeof ArtifactRuntimeLifecycle.Type;

/** A caller resolves this once per operation, never from an exact historical view. */
export interface ArtifactRuntimeTarget {
  readonly lineageId: ArtifactLineageId;
  readonly revision: number;
  readonly runtime: ArtifactRuntimeDescriptor;
}

export const ArtifactRuntimeStatus = Schema.Struct({
  lineageId: ArtifactLineageId,
  revision: Schema.NullOr(Schema.Int),
  running: Schema.Boolean,
  lastError: Schema.NullOr(Schema.String),
});
export interface ArtifactRuntimeStatus extends Schema.Schema.Type<typeof ArtifactRuntimeStatus> {}

export class ArtifactRuntimeError extends Schema.TaggedError<ArtifactRuntimeError>()(
  "ArtifactRuntimeError",
  { operation: Schema.String, message: Schema.String },
) {}
