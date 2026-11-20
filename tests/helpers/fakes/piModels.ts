import { Effect, Layer } from "effect";
import { makePiModels, PiModels } from "../../../src/services/pi/PiModels";

type Service = PiModels["Service"];

/** The real catalog logic over an empty provider catalog: nothing resolves or completes. */
const neutralPiModels = (): Service =>
  makePiModels({
    loadCatalog: () => Effect.succeed([]),
    loadNonChatCatalog: () => Effect.succeed([]),
    refreshCatalog: () => Effect.void,
    login: (provider) => Effect.fail(new Error(`No fake provider ${provider}`)),
    logout: () => Effect.void,
    complete: () => Effect.fail(new Error("No fake provider can complete")),
  });

export const fakePiModels = (overrides: Partial<Service> = {}) =>
  Layer.sync(PiModels, () => PiModels.of({ ...neutralPiModels(), ...overrides }));
