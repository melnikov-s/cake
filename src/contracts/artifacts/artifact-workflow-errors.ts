import { Schema } from "effect";

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  lineageId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
}) {}

export class ArtifactNotLinked extends Schema.TaggedError<ArtifactNotLinked>()(
  "ArtifactNotLinked",
  {
    sessionId: Schema.String,
    lineageId: Schema.String,
  },
) {}
