import { Context, Effect, Layer } from "effect";
import type { PluginAgentResources } from "./PluginHost";

export interface PluginResourcesService {
  readonly current: () => PluginAgentResources;
  readonly replace: (resources: PluginAgentResources) => Effect.Effect<void>;
}

/** Process-local projection of the resources contributed by enabled Cake Plugins. */
export class PluginResources extends Context.Service<PluginResources, PluginResourcesService>()(
  "cake/services/plugins/PluginResources",
) {
  static readonly layer = Layer.sync(PluginResources, () => {
    let resources: PluginAgentResources = { skills: [], prompts: [], extensions: [] };
    return PluginResources.of({
      current: () => resources,
      replace: Effect.fn("PluginResources.replace")((next) =>
        Effect.sync(() => {
          resources = next;
        }),
      ),
    });
  });
}
