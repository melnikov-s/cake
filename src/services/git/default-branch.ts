import { Effect } from "effect";
import { Git } from "./Git";

/** Locally recorded remote default; never contacts the remote or guesses from checked-out HEAD. */
export const localDefaultBranch = Effect.fn("Git.localDefaultBranch")(function* (root: string) {
  const git = yield* Git;
  return yield* git.run(root, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]).pipe(
    Effect.map((value) => value.trim().replace(/^origin\//, "")),
    Effect.catch(() => Effect.succeed(undefined)),
  );
});
