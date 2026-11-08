import { createHash, randomUUID } from "node:crypto";
import { Cause, Clock, Effect, Exit, Option, Predicate } from "effect";

/** Shared by desktop lifecycle receipts and local landing phases, not a transcript identity. */
export const responsivenessRun = randomUUID();
export const diagnosticId = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const causeType = (cause: Cause.Cause<unknown>) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error)) return Cause.hasInterrupts(cause) ? "interruption" : "defect";
  const value = error.value;
  const tag = Predicate.isObject(value) && "_tag" in value ? value._tag : undefined;
  return (
    [
      "GitError",
      "ManagedWorktreeError",
      "WorktreeLandingError",
      "WorktreeLandingAgentError",
      "PlatformError",
    ].find((known) => known === tag) ?? "operational-error"
  );
};

export const landingMark = (
  operationId: string,
  phase: string,
  fields: Readonly<Record<string, string | number | boolean>> = {},
) =>
  Effect.logInfo("Cake landing", {
    run: responsivenessRun,
    landing: diagnosticId(operationId),
    phase,
    ...fields,
  });

/** Boundary timings overlap workflow phases. Never sum nested durations. No Git output is logged. */
export const measureLanding = Effect.fn("LandingDiagnostics.measure")(function* <A, E, R>(
  operationId: string,
  phase: string,
  effect: Effect.Effect<A, E, R>,
) {
  const started = yield* Clock.currentTimeMillis;
  yield* landingMark(operationId, phase, { status: "started" });
  return yield* effect.pipe(
    Effect.onExit((exit) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const fields = {
            status: Exit.isSuccess(exit)
              ? "succeeded"
              : Cause.hasInterrupts(exit.cause)
                ? "canceled"
                : "failed",
            durationMs: Math.max(0, now - started),
          };
          // Fingerprint preserves correlation without retaining arbitrary command/error bodies.
          if (Exit.isFailure(exit)) {
            Object.assign(fields, {
              cause: diagnosticId(Cause.pretty(exit.cause)),
              causeType: causeType(exit.cause),
            });
          }
          return landingMark(operationId, phase, fields);
        }),
      ),
    ),
  );
});
