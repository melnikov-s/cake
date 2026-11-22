import { Effect } from "effect";
import { PiModelCatalogError } from "../../contracts/pi/model-data";
import { AntigravityModels } from "../../services/antigravity/AntigravityModels";
import { ClientConnections } from "../../services/clients/ClientConnections";
import { RendererConnection } from "../protocol/RendererConnectionMiddleware";
import * as modelPresets from "../../domain/model-presets/modelPresets";
import { refreshModelCatalog } from "../../domain/model-preferences/refresh-model-catalog";
import { PiModels } from "../../services/pi/PiModels";
import { ModelRpc } from "../protocol/ModelRpc";
import { updateNonChatModelPreference } from "../../domain/model-preferences/non-chat-model-preferences";

export const modelHandlers = ModelRpc.of({
  "nonChatModels.list": () => Effect.flatMap(PiModels, (models) => models.listNonChat()),
  "nonChatModels.updatePreference": (input) => updateNonChatModelPreference(input),
  "models.list": () => Effect.flatMap(PiModels, (models) => models.list()),
  "models.refresh": () => refreshModelCatalog(),
  "models.catalogAntigravity": ({ force }) =>
    Effect.gen(function* () {
      const { connectionId } = yield* RendererConnection;
      const connections = yield* ClientConnections;
      if (connections.kind(connectionId) !== "desktop")
        return yield* new PiModelCatalogError({
          operation: force ? "refresh" : "load",
          message: "Antigravity model discovery requires a desktop connection.",
        });
      return yield* (yield* AntigravityModels).catalog(force);
    }),
  "modelPresets.list": () => modelPresets.list(),
  "modelPresets.readPrompt": ({ id }) => modelPresets.readPrompt(id),
  "modelPresets.create": (input) => modelPresets.create(input),
  "modelPresets.update": (input) => modelPresets.update(input),
  "modelPresets.reorder": (input) => modelPresets.reorder(input),
  "modelPresets.remove": ({ id }) => modelPresets.remove(id),
  "modelPresets.setDefault": ({ id }) => modelPresets.setDefault(id),
  "modelPresets.resolve": ({ id }) => modelPresets.resolve(id),
});
