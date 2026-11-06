import { Schema } from "effect";

export class RendererRequestCoordinatorError extends Schema.TaggedError<RendererRequestCoordinatorError>()(
  "RendererRequestCoordinatorError",
  { operation: Schema.String, message: Schema.String },
) {}

export const coordinatorError = (operation: string, message: string) =>
  new RendererRequestCoordinatorError({ operation, message });
