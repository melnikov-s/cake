import { Effect, Layer } from "effect";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../../app/helpers/familyStorageHarness";

type Service = SessionFamilyStorage["Service"];

/** The real storage over an empty in-memory document, so every method stays complete and
 * consistent; overrides replace individual methods. Use familyStorageHarness to inspect files. */
export const fakeSessionFamilyStorage = (overrides: Partial<Service> = {}) =>
  Layer.effect(
    SessionFamilyStorage,
    Effect.map(SessionFamilyStorage, (storage) =>
      SessionFamilyStorage.of({ ...storage, ...overrides }),
    ),
  ).pipe(Layer.provide(familyStorageHarness().layer));
