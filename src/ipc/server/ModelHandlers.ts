import { Effect } from "effect";
import * as modelPresets from "../../domain/model-presets/modelPresets";
import { PiModels } from "../../services/pi/PiModels";
import { ModelRpc } from "../protocol/ModelRpc";
import { updateNonChatModelPreference } from "../../domain/model-preferences/non-chat-model-preferences";

export const modelHandlers = ModelRpc.of({
  "nonChatModels.list": () => Effect.flatMap(PiModels, (models) => models.listNonChat()),
  "nonChatModels.updatePreference": (input) => updateNonChatModelPreference(input),
  "models.list": () => Effect.flatMap(PiModels, (models) => models.list()),
  "models.refresh": () => Effect.flatMap(PiModels, (models) => models.refreshCatalog()),
  "modelPresets.list": () => modelPresets.list(),
  "modelPresets.create": (input) => modelPresets.create(input),
  "modelPresets.update": (input) => modelPresets.update(input),
  "modelPresets.reorder": (input) => modelPresets.reorder(input),
  "modelPresets.remove": ({ id }) => modelPresets.remove(id),
  "modelPresets.setDefault": ({ id }) => modelPresets.setDefault(id),
  "modelPresets.resolve": ({ id }) => modelPresets.resolve(id),
});
