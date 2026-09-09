import { Context, Layer, Schema, type Effect } from "effect";
import type { ReviewParentContext } from "../pi/runtime/sidecar-runtime";
import type { DiscussionAnchor } from "../../domain/discussion-sessions/discussion-session-data";

export interface DiscussionSessionRecord {
  readonly id: string;
  readonly workingDirectory: string;
  readonly parentSessionId: string;
  readonly sidecarSessionId?: string;
  readonly sidecarSessionFile?: string;
  /** Cake-owned comments awaiting delivery to a sidecar Pi transcript. */
  readonly pendingParts: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>;
  readonly anchor: DiscussionAnchor;
  readonly status: "open" | "resolved";
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly resolvedAt?: string;
}

interface DiscussionSessionLocation {
  readonly agentDirectory: string;
  readonly sessionDirectory: string;
  readonly parentSessionDirectory: string;
  readonly trusted: boolean;
}

export class DiscussionSessionEnvironmentError extends Schema.TaggedError<DiscussionSessionEnvironmentError>()(
  "DiscussionSessionEnvironmentError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface DiscussionSessionEnvironmentService {
  readonly list: (
    workingDirectory: string,
    parentSessionId: string,
  ) => Effect.Effect<ReadonlyArray<DiscussionSessionRecord>, DiscussionSessionEnvironmentError>;
  readonly get: (
    workingDirectory: string,
    parentSessionId: string,
    threadId: string,
  ) => Effect.Effect<DiscussionSessionRecord, DiscussionSessionEnvironmentError>;
  readonly create: (
    workingDirectory: string,
    parentSessionId: string,
    anchor: DiscussionAnchor,
  ) => Effect.Effect<DiscussionSessionRecord, DiscussionSessionEnvironmentError>;
  readonly linkSidecar: (
    record: DiscussionSessionRecord,
    sidecar: { readonly sessionId: string; readonly sessionFile: string },
  ) => Effect.Effect<DiscussionSessionRecord, DiscussionSessionEnvironmentError>;
  readonly setResolved: (
    record: DiscussionSessionRecord,
    resolved: boolean,
  ) => Effect.Effect<DiscussionSessionRecord, DiscussionSessionEnvironmentError>;
  readonly location: (
    record: DiscussionSessionRecord,
  ) => Effect.Effect<DiscussionSessionLocation, DiscussionSessionEnvironmentError>;
  readonly prepareParentContext: (
    record: DiscussionSessionRecord,
    parent: ReviewParentContext,
  ) => Effect.Effect<string, DiscussionSessionEnvironmentError>;
  readonly refreshParentIndex: (
    record: DiscussionSessionRecord,
  ) => Effect.Effect<void, DiscussionSessionEnvironmentError>;
}

export class DiscussionSessionEnvironment extends Context.Service<
  DiscussionSessionEnvironment,
  DiscussionSessionEnvironmentService
>()("cake/services/discussion-sessions/DiscussionSessionEnvironment") {}

export const makeDiscussionSessionEnvironmentLayer = (
  operations: DiscussionSessionEnvironmentService,
) => Layer.succeed(DiscussionSessionEnvironment, DiscussionSessionEnvironment.of(operations));
