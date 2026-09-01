import { Effect, Schema } from "effect";
import { ReviewStorage } from "../services/storage/ReviewStorage";

class ReviewError extends Schema.TaggedError<ReviewError>()("ReviewError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const asError = (operation: string) =>
  Effect.mapError(
    (error: unknown) =>
      new ReviewError({
        operation,
        message: error instanceof Error ? error.message : String(error),
      }),
  );

export const deleteSession = Effect.fn("Reviews.deleteSession")(function* (
  workingDirectory: string,
  sessionId: string,
) {
  const storage = yield* ReviewStorage;
  yield* storage.deleteSession(workingDirectory, sessionId).pipe(asError("deleteSession"));
});
