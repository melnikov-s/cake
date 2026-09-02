import { Schema } from "effect";

export class ProjectError extends Schema.TaggedError<ProjectError>()("ProjectError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
