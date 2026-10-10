import { Schema } from "effect";

export class ApplicationEncodeError extends Schema.TaggedError<ApplicationEncodeError>()(
  "ApplicationEncodeError",
  { message: Schema.String },
) {}

export class ApplicationWriteError extends Schema.TaggedError<ApplicationWriteError>()(
  "ApplicationWriteError",
  { stage: Schema.Literals(["write", "rename"]), message: Schema.String },
) {}
