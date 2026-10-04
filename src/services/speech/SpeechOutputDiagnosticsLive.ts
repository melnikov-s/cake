import { Effect, FileSystem, Layer, Schema, Semaphore } from "effect";
import { SpeechOutputDiagnostic, SpeechOutputDiagnostics } from "./SpeechOutputDiagnostics";

/** Lazy, private, bounded persistence: retain only the latest synthesis failure. */
export const makeSpeechOutputDiagnosticsLive = (directory: string) =>
  Layer.effect(
    SpeechOutputDiagnostics,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const lock = yield* Semaphore.make(1);
      const record = Effect.fn("SpeechOutputDiagnostics.record")(
        function* (diagnostic: SpeechOutputDiagnostic) {
          const content = yield* Schema.encodeEffect(Schema.fromJsonString(SpeechOutputDiagnostic))(
            diagnostic,
          );
          yield* Effect.logWarning("ElevenLabs synthesis failed", diagnostic);
          yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
          yield* fs.chmod(directory, 0o700);
          yield* Effect.acquireUseRelease(
            fs.makeTempFile({ directory, prefix: ".diagnostic-", suffix: ".tmp" }),
            (temporary) =>
              Effect.gen(function* () {
                yield* fs.chmod(temporary, 0o600);
                yield* fs.writeFileString(temporary, content, { mode: 0o600 });
                yield* fs.rename(temporary, `${directory}/last-failure.json`);
              }),
            (temporary) => fs.remove(temporary, { force: true }).pipe(Effect.ignore),
          );
        },
        lock.withPermit,
        Effect.catch(() => Effect.logWarning("Could not save speech diagnostic report")),
      );
      return SpeechOutputDiagnostics.of({ record });
    }),
  );
