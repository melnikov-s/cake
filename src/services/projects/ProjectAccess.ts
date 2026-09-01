import { Context, Schema, type Effect } from "effect";

export class ProjectAccessError extends Schema.TaggedError<ProjectAccessError>()(
  "ProjectAccessError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ProjectAccessService {
  readonly allow: (workingDirectory: string) => Effect.Effect<void>;
  readonly revoke: (workingDirectory: string) => Effect.Effect<void>;
  readonly isAllowed: (workingDirectory: string) => Effect.Effect<boolean>;
  readonly allowedWorkingDirectories: () => Effect.Effect<ReadonlyArray<string>>;
  readonly rememberSessionLocation: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<void, ProjectAccessError>;
  readonly forgetSessionLocation: (sessionId: string) => Effect.Effect<void>;
  readonly forgetWorkingDirectories: (
    workingDirectories: ReadonlySet<string>,
  ) => Effect.Effect<void>;
  readonly resolveSessionWorkingDirectory: (
    sessionId: string,
  ) => Effect.Effect<string, ProjectAccessError>;
  readonly requestTrust: (
    ownerId: number,
    requestId: string,
    workingDirectory: string,
  ) => Effect.Effect<void>;
  readonly consumeTrustRequest: (
    ownerId: number,
    requestId: string,
    workingDirectory: string,
  ) => Effect.Effect<void, ProjectAccessError>;
  readonly clearOwner: (ownerId: number) => Effect.Effect<void>;
}

/** Main-owned authorization and ephemeral Project/Session location authority. */
export class ProjectAccess extends Context.Service<ProjectAccess, ProjectAccessService>()(
  "cake/services/projects/ProjectAccess",
) {}
