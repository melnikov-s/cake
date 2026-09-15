import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetCreateInput,
  ModelPresetLimitError,
  ModelPresetNotFoundError,
  ModelPresetOrderInput,
  ModelPresetProjection,
  ModelPresetUpdateInput,
  ModelPresetValidationError,
} from "../../domain/model-presets/modelPresets";
import {
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  PiProviderAuthError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnknownPiModelError,
  UnsupportedFastModeError,
  UnsupportedThinkingLevelError,
} from "../../services/pi/model-data";
import {
  ApplicationEncodeError,
  ApplicationWriteError,
} from "../../services/storage/ApplicationStorage";

const ModelPresetMutationError = Schema.Union([
  ModelPresetValidationError,
  ModelPresetNotFoundError,
  DefaultModelPresetNotFoundError,
  DuplicateModelPresetIdError,
  ModelPresetLimitError,
  ApplicationEncodeError,
  ApplicationWriteError,
]);

const ModelResolutionError = Schema.Union([
  ModelPresetNotFoundError,
  PiModelCatalogError,
  UnknownPiModelError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnsupportedThinkingLevelError,
  UnsupportedFastModeError,
]);

export const ModelRpc = RpcGroup.make(
  Rpc.make("models.list", {
    success: Schema.Array(PiModel),
    error: PiModelCatalogError,
  }),
  Rpc.make("models.refresh", { error: PiModelCatalogError }),
  Rpc.make("models.login", {
    payload: {
      provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      authType: Schema.Literals(["api_key", "oauth"]),
    },
    error: PiProviderAuthError,
  }),
  Rpc.make("models.logout", {
    payload: { provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)) },
    error: PiProviderAuthError,
  }),
  Rpc.make("modelPresets.list", { success: ModelPresetProjection }),
  Rpc.make("modelPresets.create", {
    payload: ModelPresetCreateInput,
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.update", {
    payload: ModelPresetUpdateInput,
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.reorder", {
    payload: ModelPresetOrderInput,
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.remove", {
    payload: { id: Schema.String.check(Schema.isUUID(4)) },
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.setDefault", {
    payload: { id: Schema.optional(Schema.String.check(Schema.isUUID(4))) },
    success: ModelPresetProjection,
    error: ModelPresetMutationError,
  }),
  Rpc.make("modelPresets.resolve", {
    payload: { id: Schema.String.check(Schema.isUUID(4)) },
    success: ModelSelection,
    error: ModelResolutionError,
  }),
);
