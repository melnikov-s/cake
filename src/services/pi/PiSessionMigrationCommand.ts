import { NodeFileSystem, NodePath, NodeRuntime } from "@effect/platform-node-shared";
import { Effect, Layer } from "effect";
import { resolveCakePaths } from "../../config/CakePaths";
import { makeWorktreeStorageLive } from "../storage/WorktreeStorageLive";
import { makeSessionArchiveStorageLive } from "../storage/SessionArchiveStorageLive";
import { planPiSessionMigration, applyPiSessionMigration } from "./PiSessionMigration";

const arguments_ = process.argv.slice(2);
if (arguments_.length !== 1 || !["--plan", "--apply"].includes(arguments_[0] ?? "")) {
  throw new Error(
    "Use --plan for read-only inspection or --apply to explicitly migrate. Close Cake and Pi before --apply.",
  );
}
const paths = resolveCakePaths();
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const storage = Layer.mergeAll(
  makeWorktreeStorageLive(paths.worktrees),
  makeSessionArchiveStorageLive(paths.resolvedProjectMetadata, {
    activeRoot: paths.piSessions,
    resolvedRoot: paths.piResolvedSessions,
  }),
).pipe(Layer.provide(platform));

NodeRuntime.runMain(
  Effect.gen(function* () {
    const plan = yield* planPiSessionMigration(paths);
    console.info(JSON.stringify(plan, null, 2));
    if (arguments_[0] === "--apply")
      console.info(JSON.stringify(yield* applyPiSessionMigration(paths, plan), null, 2));
  }).pipe(Effect.provide(storage), Effect.provide(platform)),
);
