import { Context, type Effect, type Schema } from "effect";
import type { ArtifactLineageId } from "../../contracts/artifacts/artifact-lineage";
import type {
  ArtifactRuntimeError,
  ArtifactRuntimeLifecycle,
  ArtifactRuntimeStatus,
  ArtifactRuntimeTarget,
} from "../../contracts/artifacts/artifact-runtime";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import type { ArtifactRuntimeTool } from "../../contracts/artifacts/artifact-runtime-descriptor";

export interface ArtifactRuntimeInvocation {
  readonly target: ArtifactRuntimeTarget;
  readonly callingSessionId?: string;
  readonly windowConnectionId?: number;
}
export interface ArtifactRuntimeHost {
  /** Composition supplies canonical Cake dispatch, not a renderer or a synthetic session. */
  readonly invokeCommand: (input: {
    readonly lineageId: ArtifactLineageId;
    readonly command: string;
    readonly input: Schema.Json;
    readonly callingSessionId?: string;
    readonly windowConnectionId?: number;
  }) => Effect.Effect<Schema.Json, ArtifactRuntimeError>;
}
export class ArtifactRuntime extends Context.Service<
  ArtifactRuntime,
  {
    readonly setHost: (host: ArtifactRuntimeHost) => Effect.Effect<void, ArtifactRuntimeError>;
    /** Validates definitions without executing source or starting side effects. */
    readonly listTools: (
      target: ArtifactRuntimeTarget,
    ) => Effect.Effect<ReadonlyArray<ArtifactRuntimeTool>, ArtifactRuntimeError>;
    readonly call: (
      input: ArtifactRuntimeInvocation & { readonly name: string; readonly input: Schema.Json },
    ) => Effect.Effect<Schema.Json, ArtifactRuntimeError>;
    readonly lifecycle: (
      input: ArtifactRuntimeInvocation & {
        readonly event: ArtifactRuntimeLifecycle;
        readonly viewId?: string;
        readonly navigation?: ArtifactNavigationContext;
      },
    ) => Effect.Effect<ArtifactRuntimeStatus, ArtifactRuntimeError>;
    /** Does not start a runtime. Stop/delete likewise never start an absent runtime. */
    readonly status: (lineageId: ArtifactLineageId) => Effect.Effect<ArtifactRuntimeStatus>;
    readonly stop: (
      lineageId: ArtifactLineageId,
      event?: "stop" | "delete",
      callingSessionId?: string,
      windowConnectionId?: number,
    ) => Effect.Effect<ArtifactRuntimeStatus, ArtifactRuntimeError>;
  }
>()("cake/services/artifact-runtime/ArtifactRuntime") {}
