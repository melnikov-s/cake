import { Schema } from "effect";

export class WindowStateReadError extends Schema.TaggedError<WindowStateReadError>()(
  "WindowStateReadError",
  { message: Schema.String },
) {}

export class WindowStateMalformedDocumentError extends Schema.TaggedError<WindowStateMalformedDocumentError>()(
  "WindowStateMalformedDocumentError",
  { message: Schema.String },
) {}

export class WindowStateUnsupportedVersionError extends Schema.TaggedError<WindowStateUnsupportedVersionError>()(
  "WindowStateUnsupportedVersionError",
  { version: Schema.Int, currentVersion: Schema.Int },
) {}

export class WindowStateEncodeError extends Schema.TaggedError<WindowStateEncodeError>()(
  "WindowStateEncodeError",
  { message: Schema.String },
) {}

export class WindowStateWriteError extends Schema.TaggedError<WindowStateWriteError>()(
  "WindowStateWriteError",
  { stage: Schema.Literals(["write", "rename"]), message: Schema.String },
) {}
