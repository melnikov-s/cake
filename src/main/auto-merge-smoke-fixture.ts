import { Deferred, Effect } from "effect";
import { ApplicationState } from "../services/storage/ApplicationState";

/** Local smoke only: hold the real application transaction lock, not the toggle or UI.
 * The isolated test owns release; runtime shutdown interrupts an abandoned hold.
 */
export function installAutoMergeSmokeFixture(
  run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>,
) {
  let active: { release: Deferred.Deferred<void>; done: Promise<unknown> } | undefined;
  Object.assign(globalThis, {
    async cakeSmokeHoldApplicationCommit() {
      if (active) throw new Error("Application commit fixture already active");
      const application = await run(Effect.serviceOption(ApplicationState));
      if (application._tag === "None") throw new Error("Local-only application commit fixture");
      const entered = await run(Deferred.make<void>());
      const release = await run(Deferred.make<void>());
      const done = run(
        application.value.transact((state) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as(state),
          ),
        ),
      );
      active = { release, done };
      await run(Deferred.await(entered));
    },
    async cakeSmokeReleaseApplicationCommit() {
      if (!active) throw new Error("Application commit fixture is not active");
      const current = active;
      await run(Deferred.succeed(current.release, undefined));
      try {
        await current.done;
      } finally {
        active = undefined;
      }
    },
  });
}
