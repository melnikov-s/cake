import { Context, Effect, Layer, Schema } from "effect";
import {
  BoundedCompletionInput,
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  PiModelCompletionError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnknownPiModelError,
  UnsupportedFastModeError,
  UnsupportedThinkingLevelError,
  type BoundedCompletionInput as BoundedCompletionInputValue,
  type ModelSelection as ModelSelectionValue,
  type PiModelResolutionError,
} from "./model-data";

export interface PiModelsAdapter {
  readonly loadCatalog: () => Effect.Effect<unknown, unknown>;
  readonly refreshCatalog: () => Effect.Effect<void, unknown>;
  readonly complete: (input: BoundedCompletionInputValue) => Effect.Effect<string, unknown>;
}

export class PiModels extends Context.Service<
  PiModels,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<PiModel>, PiModelCatalogError>;
    readonly refreshCatalog: () => Effect.Effect<void, PiModelCatalogError>;
    readonly resolve: (
      selection: ModelSelectionValue,
    ) => Effect.Effect<ModelSelectionValue, PiModelCatalogError | PiModelResolutionError>;
    readonly complete: (
      input: BoundedCompletionInputValue,
    ) => Effect.Effect<
      string,
      PiModelCatalogError | PiModelResolutionError | PiModelCompletionError
    >;
  }
>()("cake/services/pi/PiModels") {}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const makePiModels = (adapter: PiModelsAdapter): PiModels["Service"] => {
  const list = Effect.fn("PiModels.list")(function* () {
    const catalog = yield* adapter
      .loadCatalog()
      .pipe(
        Effect.mapError(
          (cause) => new PiModelCatalogError({ operation: "load", message: messageOf(cause) }),
        ),
      );
    return yield* Schema.decodeUnknownEffect(Schema.Array(PiModel))(catalog).pipe(
      Effect.mapError(
        (cause) => new PiModelCatalogError({ operation: "load", message: cause.message }),
      ),
    );
  });

  const refreshCatalog = Effect.fn("PiModels.refreshCatalog")(() =>
    adapter
      .refreshCatalog()
      .pipe(
        Effect.mapError(
          (cause) => new PiModelCatalogError({ operation: "refresh", message: messageOf(cause) }),
        ),
      ),
  );

  const resolve = Effect.fn("PiModels.resolve")(function* (selection: ModelSelectionValue) {
    const decoded = yield* Schema.decodeUnknownEffect(ModelSelection)(selection).pipe(
      Effect.mapError(
        () =>
          new UnknownPiModelError({
            provider: selection.provider,
            modelId: selection.modelId,
          }),
      ),
    );
    const models = yield* list();
    const model = models.find(
      (candidate) => candidate.provider === decoded.provider && candidate.id === decoded.modelId,
    );
    if (!model)
      return yield* new UnknownPiModelError({
        provider: decoded.provider,
        modelId: decoded.modelId,
      });
    if (!model.authenticated)
      return yield* new UnauthenticatedPiModelError({
        provider: decoded.provider,
        modelId: decoded.modelId,
      });
    if (!model.available)
      return yield* new UnavailablePiModelError({
        provider: decoded.provider,
        modelId: decoded.modelId,
      });
    if (!model.supportedThinkingLevels.includes(decoded.thinkingLevel))
      return yield* new UnsupportedThinkingLevelError({
        provider: decoded.provider,
        modelId: decoded.modelId,
        thinkingLevel: decoded.thinkingLevel,
        supportedThinkingLevels: model.supportedThinkingLevels,
      });
    if (decoded.fastMode && !model.fastMode)
      return yield* new UnsupportedFastModeError({
        provider: decoded.provider,
        modelId: decoded.modelId,
      });
    return decoded;
  });

  const complete = Effect.fn("PiModels.complete")(function* (input: BoundedCompletionInputValue) {
    const decoded = yield* Schema.decodeUnknownEffect(BoundedCompletionInput)(input).pipe(
      Effect.mapError((cause) => new PiModelCompletionError({ message: cause.message })),
    );
    yield* resolve(decoded.selection);
    const text = yield* adapter.complete(decoded).pipe(
      Effect.mapError((cause) => new PiModelCompletionError({ message: messageOf(cause) })),
      Effect.timeout(decoded.timeoutMs),
      Effect.mapError((cause) =>
        cause instanceof PiModelCompletionError
          ? cause
          : new PiModelCompletionError({ message: "Bounded model completion timed out" }),
      ),
    );
    return text.slice(0, decoded.maximumOutputCharacters);
  });

  return PiModels.of({ list, refreshCatalog, resolve, complete });
};

export const makePiModelsLayer = (adapter: PiModelsAdapter) =>
  Layer.succeed(PiModels)(makePiModels(adapter));
