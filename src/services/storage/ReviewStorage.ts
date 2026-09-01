import { Context, Schema, type Effect } from "effect";
import type { ReviewAnchor, ReviewThread, ReviewThreadRecord } from "../../ipc/review-contract";

export class ReviewStorageError extends Schema.TaggedError<ReviewStorageError>()(
  "ReviewStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ReviewStorageService {
  readonly agentSessionDirectory: (
    workingDirectory: string,
    sessionId: string,
    threadId: string,
  ) => Effect.Effect<string>;
  readonly reviewContextPath: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<string>;
  readonly discussionParentContextPath: (
    workingDirectory: string,
    sessionId: string,
    threadId: string,
  ) => Effect.Effect<string>;
  readonly deleteSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<void, ReviewStorageError>;
  readonly listSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<ReviewThread>, ReviewStorageError>;
  readonly listDiscussionRecords: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<ReviewThreadRecord>, ReviewStorageError>;
  readonly get: (
    workingDirectory: string,
    sessionId: string,
    threadId: string,
  ) => Effect.Effect<ReviewThreadRecord | undefined, ReviewStorageError>;
  readonly createDiscussion: (
    workingDirectory: string,
    sessionId: string,
    anchor: ReviewAnchor,
  ) => Effect.Effect<ReviewThreadRecord, ReviewStorageError>;
  readonly linkDiscussionSidecar: (
    workingDirectory: string,
    sessionId: string,
    threadId: string,
    sidecar: { readonly sessionId: string; readonly sessionFile: string },
  ) => Effect.Effect<ReviewThreadRecord, ReviewStorageError>;
  readonly resolve: (
    workingDirectory: string,
    sessionId: string,
    threadId: string,
    resolved: boolean,
  ) => Effect.Effect<ReviewThread, ReviewStorageError>;
  readonly refreshDiscussionContext: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<void, ReviewStorageError>;
}

export class ReviewStorage extends Context.Service<ReviewStorage, ReviewStorageService>()(
  "cake/services/storage/ReviewStorage",
) {}
