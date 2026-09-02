import { Context, Effect, Layer } from "effect";

export interface PluginAgentResources {
  readonly skills: readonly string[];
  readonly prompts: readonly string[];
  readonly extensions: readonly string[];
}

export interface PluginResourcesSnapshot {
  readonly revision: number;
  readonly resources: PluginAgentResources;
}

export interface PluginResourcesService {
  readonly current: () => PluginResourcesSnapshot;
  readonly replace: (resources: PluginAgentResources) => Effect.Effect<PluginResourcesSnapshot>;
}

/** Process-local projection of the resources contributed by enabled Cake Plugins. */
export class PluginResources extends Context.Service<PluginResources, PluginResourcesService>()(
  "cake/services/plugins/PluginResources",
) {
  static readonly layer = Layer.sync(PluginResources, () => {
    let snapshot: PluginResourcesSnapshot = {
      revision: 0,
      resources: { skills: [], prompts: [], extensions: [] },
    };
    return PluginResources.of({
      current: () => snapshot,
      replace: Effect.fn("PluginResources.replace")((next) =>
        Effect.sync(() => {
          snapshot = {
            revision: snapshot.revision + 1,
            resources: {
              skills: [...next.skills],
              prompts: [...next.prompts],
              extensions: [...next.extensions],
            },
          };
          return snapshot;
        }),
      ),
    });
  });
}
