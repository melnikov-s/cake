import { Effect, FileSystem, Layer, Schema, Semaphore, type Types } from "effect";
import { SpeechOutputError } from "../../domain/speech/speech-output-data";
import { SpeechOutputStorage, StoredSpeechOutputSettings } from "./SpeechOutputStorage";

/** Outside-world encryption adapter supplied by desktop main using Electron safeStorage.
 * available() is false for unavailable encryption or an insecure basic_text backend.
 */
export interface SpeechKeyEncryption {
  available(): boolean;
  encrypt(plaintext: string): Uint8Array;
  decrypt(ciphertext: Uint8Array): string;
}

const document = Schema.Struct({
  version: Schema.Literal(1),
  encryptedApiKey: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(4),
      Schema.isMaxLength(32_768),
      Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/),
    ),
  ),
  voiceId: StoredSpeechOutputSettings.fields.voiceId,
  speed: StoredSpeechOutputSettings.fields.speed,
  voices: StoredSpeechOutputSettings.fields.voices,
});
const storageError = () =>
  new SpeechOutputError({
    kind: "storage",
    message:
      "Could not read or save speech settings. Check private storage and secure key encryption availability.",
  });

/** Acquisition is inert: optional storage/encryption failures belong to operations, not startup.
 * Only ciphertext is written, to a private sibling file followed by atomic replacement.
 */
export const makeSpeechOutputStorageLive = (
  directory: string,
  encryption: SpeechKeyEncryption,
): Layer.Layer<SpeechOutputStorage, never, FileSystem.FileSystem> =>
  Layer.effect(
    SpeechOutputStorage,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* Semaphore.make(1);
      const target = `${directory}/settings.json`;

      const load = Effect.fn("SpeechOutputStorage.load")(function* () {
        const raw = yield* fs
          .readFileString(target)
          .pipe(
            Effect.catch((error) =>
              error.reason._tag === "NotFound"
                ? Effect.succeed(undefined)
                : Effect.fail(storageError()),
            ),
          );
        if (raw === undefined) return {};
        const saved = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(document))(raw).pipe(
          Effect.mapError(storageError),
        );
        const ciphertext = saved.encryptedApiKey;
        const apiKey =
          ciphertext === undefined
            ? undefined
            : yield* Effect.try({
                try: () => {
                  if (!encryption.available()) throw new Error("Secure encryption unavailable");
                  const bytes = Buffer.from(ciphertext, "base64");
                  if (bytes.toString("base64") !== ciphertext)
                    throw new Error("Invalid ciphertext");
                  return encryption.decrypt(bytes);
                },
                catch: storageError,
              });
        const settings: Types.Mutable<StoredSpeechOutputSettings> = {};
        if (apiKey !== undefined) settings.apiKey = apiKey;
        if (saved.voiceId !== undefined) settings.voiceId = saved.voiceId;
        if (saved.speed !== undefined) settings.speed = saved.speed;
        if (saved.voices !== undefined) settings.voices = saved.voices;
        return yield* Schema.decodeUnknownEffect(StoredSpeechOutputSettings)(settings).pipe(
          Effect.mapError(storageError),
        );
      }, lock.withPermit);

      const save = Effect.fn("SpeechOutputStorage.save")(function* (
        settings: StoredSpeechOutputSettings,
      ) {
        const apiKey = settings.apiKey;
        const encryptedApiKey =
          apiKey === undefined
            ? undefined
            : yield* Effect.try({
                try: () => {
                  if (!encryption.available()) throw new Error("Secure encryption unavailable");
                  const bytes = encryption.encrypt(apiKey);
                  if (bytes.byteLength === 0) throw new Error("Empty ciphertext");
                  return Buffer.from(bytes).toString("base64");
                },
                catch: storageError,
              });
        const saved: Types.Mutable<Schema.Schema.Type<typeof document>> = { version: 1 };
        if (encryptedApiKey !== undefined) saved.encryptedApiKey = encryptedApiKey;
        if (settings.voiceId !== undefined) saved.voiceId = settings.voiceId;
        if (settings.speed !== undefined) saved.speed = settings.speed;
        if (settings.voices !== undefined) saved.voices = settings.voices;
        const content = yield* Schema.encodeEffect(Schema.fromJsonString(document))(saved).pipe(
          Effect.mapError(storageError),
        );
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(storageError));
        yield* fs.chmod(directory, 0o700).pipe(Effect.mapError(storageError));
        yield* Effect.acquireUseRelease(
          fs
            .makeTempFile({ directory, prefix: ".speech-", suffix: ".tmp" })
            .pipe(Effect.mapError(storageError)),
          (temporary) =>
            Effect.gen(function* () {
              // Tighten permissions before any ciphertext is written, even on existing temp files.
              yield* fs.chmod(temporary, 0o600);
              yield* fs.writeFileString(temporary, content, { mode: 0o600 });
              yield* fs.rename(temporary, target);
            }).pipe(Effect.mapError(storageError)),
          (temporary) => fs.remove(temporary, { force: true }).pipe(Effect.ignore),
        );
      }, lock.withPermit);

      return SpeechOutputStorage.of({ load, save });
    }),
  );
