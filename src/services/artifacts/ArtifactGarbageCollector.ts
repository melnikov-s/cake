import { Context, type Effect } from "effect";

/** Process-scoped best-effort maintenance trigger; requests are coalesced. */
export class ArtifactGarbageCollector extends Context.Service<
  ArtifactGarbageCollector,
  { readonly request: () => Effect.Effect<void> }
>()("cake/services/artifacts/ArtifactGarbageCollector") {}
