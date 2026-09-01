import { Context, type Effect } from "effect";

export interface RewordingRequestsService {
  readonly acquire: (ownerId: number) => Effect.Effect<AbortController>;
  readonly release: (ownerId: number, controller: AbortController) => Effect.Effect<void>;
  readonly disposeOwner: (ownerId: number) => Effect.Effect<void>;
}

/** Owns renderer-scoped composer reword cancellation resources. */
export class RewordingRequests extends Context.Service<
  RewordingRequests,
  RewordingRequestsService
>()("cake/services/projects/RewordingRequests") {}
