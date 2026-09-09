import { Effect } from "effect";
import * as modelPresets from "../../domain/modelPresets";
import { PiModels } from "../../services/pi/PiModels";
import { ModelRpc } from "../protocol/ModelRpc";

export const modelHandlers = ModelRpc.of({
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
