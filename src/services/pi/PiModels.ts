import { Context, Effect, Layer, Schema } from "effect";
import {
  BoundedCompletionInput,
  ModelSelection,
  PiModel,
  PiModelCatalogError,
  PiModelCompletionError,
  PiProviderAuthError,
  UnauthenticatedPiModelError,
  UnavailablePiModelError,
  UnknownPiModelError,
  UnsupportedFastModeError,
  UnsupportedThinkingLevelError,
  type BoundedCompletionInput as BoundedCompletionInputValue,
  type ModelSelection as ModelSelectionValue,
  type PiModelResolutionError,
} from "./model-data";

export interface PiProviderAuthInteraction {
  readonly request: (input: {
    readonly kind: "confirm" | "text" | "secret" | "select" | "manual_code";
    readonly message: string;
    readonly placeholder?: string;
    readonly options?: ReadonlyArray<{ readonly id: string; readonly label: string }>;
    readonly signal?: AbortSignal;
  }) => Promise<string | undefined>;
  readonly notify: (
    event:
      | { readonly type: "info"; readonly message: string }
      | { readonly type: "progress"; readonly message: string }
      | { readonly type: "auth_url"; readonly url: string; readonly instructions?: string }
      | {
          readonly type: "device_code";
          readonly verificationUri: string;
          readonly userCode: string;
        },
  ) => void;
}

export interface PiModelsAdapter {
  readonly loadCatalog: () => Effect.Effect<unknown, unknown>;
  readonly refreshCatalog: () => Effect.Effect<void, unknown>;
  readonly login: (
    provider: string,
    authType: "api_key" | "oauth",
    interaction: PiProviderAuthInteraction,
  ) => Effect.Effect<void, unknown>;
  readonly logout: (provider: string) => Effect.Effect<void, unknown>;
  readonly complete: (input: BoundedCompletionInputValue) => Effect.Effect<string, unknown>;
}

export class PiModels extends Context.Service<
  PiModels,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<PiModel>, PiModelCatalogError>;
    readonly refreshCatalog: () => Effect.Effect<void, PiModelCatalogError>;
    readonly login: (
      provider: string,
      authType: "api_key" | "oauth",
      interaction: PiProviderAuthInteraction,
    ) => Effect.Effect<void, PiProviderAuthError>;
    readonly logout: (provider: string) => Effect.Effect<void, PiProviderAuthError>;
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

  const login = Effect.fn("PiModels.login")(
    (provider: string, authType: "api_key" | "oauth", interaction: PiProviderAuthInteraction) =>
      adapter.login(provider, authType, interaction).pipe(
        Effect.mapError(
          (cause) =>
            new PiProviderAuthError({
              operation: "login",
              provider,
              message: messageOf(cause),
            }),
        ),
      ),
  );

  const logout = Effect.fn("PiModels.logout")((provider: string) =>
    adapter.logout(provider).pipe(
      Effect.mapError(
        (cause) =>
          new PiProviderAuthError({
            operation: "logout",
            provider,
            message: messageOf(cause),
          }),
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

  return PiModels.of({ list, refreshCatalog, login, logout, resolve, complete });
};

export const makePiModelsLayer = (adapter: PiModelsAdapter) =>
  Layer.succeed(PiModels)(makePiModels(adapter));
