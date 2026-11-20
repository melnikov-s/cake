import { Effect } from "effect";

/** For a method no neutral value can honestly answer (for example, returning a live handle).
 * Fails as a defect naming the method, so the test must override it explicitly. */
export const unstubbed = (method: string) =>
  Effect.die(new Error(`${method} has no neutral fake behavior; override it in this test`));
