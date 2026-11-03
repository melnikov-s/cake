import { Schema } from "effect";

export class ArtifactNotFound extends Schema.TaggedError<ArtifactNotFound>()("ArtifactNotFound", {
  lineageId: Schema.String,
  revision: Schema.optionalKey(Schema.Int),
}) {
  override get message() {
    return this.revision === undefined
      ? `Artifact "${this.lineageId}" was not found.`
      : `Artifact "${this.lineageId}" revision ${this.revision} was not found.`;
  }
}

export class ArtifactNotLinked extends Schema.TaggedError<ArtifactNotLinked>()(
  "ArtifactNotLinked",
  {
    sessionId: Schema.String,
    lineageId: Schema.String,
  },
) {
  override get message() {
    return `Artifact "${this.lineageId}" is not linked to session ${this.sessionId}.`;
  }
}
