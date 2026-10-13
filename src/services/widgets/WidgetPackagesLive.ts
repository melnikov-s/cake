import { Effect, FileSystem, Layer, Path, Schema, Semaphore, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  WidgetPackageError,
  WidgetPackageName,
  WidgetPackageSnapshot,
  WidgetPackageSpecifier,
} from "../../contracts/widgets/widget-packages";
import { WidgetPackages } from "./WidgetPackages";

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const Package = Schema.Struct({ version: Schema.String });
const packageError = (cause: unknown) =>
  new WidgetPackageError({ message: cause instanceof Error ? cause.message : String(cause) });

/** Shared backend-owned npm environment. No lifecycle scripts, peer auto-installs, or app mutation. */
export const makeWidgetPackagesLive = (options: {
  readonly directory: string;
  readonly npmCommand?: string;
}) =>
  Layer.effect(
    WidgetPackages,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const lock = yield* Semaphore.make(1);
      const directory = path.resolve(options.directory);
      const manifestPath = path.join(directory, "package.json");
      const ensure = Effect.fn("WidgetPackages.ensure")(function* () {
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError(packageError));
        if (!(yield* fs.exists(manifestPath).pipe(Effect.mapError(packageError)))) {
          yield* fs
            .writeFileString(
              manifestPath,
              JSON.stringify({
                name: "cake-widget-packages",
                private: true,
                version: "1.0.0",
                dependencies: {},
              }),
              { mode: 0o600 },
            )
            .pipe(Effect.mapError(packageError));
        }
      });
      const listUnlocked = Effect.fn("WidgetPackages.listUnlocked")(function* () {
        if (!(yield* fs.exists(manifestPath).pipe(Effect.mapError(packageError))))
          return { directory, packages: [] };
        const manifest = yield* fs
          .readFileString(manifestPath)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest))),
            Effect.mapError(packageError),
          );
        const packages = yield* Effect.forEach(
          Object.keys(manifest.dependencies ?? {}).sort(),
          (name) =>
            Effect.gen(function* () {
              yield* Schema.decodeUnknownEffect(WidgetPackageName)(name).pipe(
                Effect.mapError(packageError),
              );
              const installed = yield* fs
                .readFileString(path.join(directory, "node_modules", name, "package.json"))
                .pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Package))),
                  Effect.mapError(packageError),
                );
              return { name, version: installed.version };
            }),
        );
        return yield* Schema.decodeUnknownEffect(WidgetPackageSnapshot)({
          directory,
          packages,
        }).pipe(Effect.mapError(packageError));
      });
      const runNpm = Effect.fn("WidgetPackages.runNpm")(function* (args: readonly string[]) {
        yield* ensure();
        yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(
                  options.npmCommand ?? "npm",
                  [
                    ...args,
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--legacy-peer-deps",
                    "--global=false",
                    "--prefix",
                    directory,
                    "--cache",
                    path.join(directory, ".npm-cache"),
                  ],
                  { cwd: directory, env: { NPM_CONFIG_WORKSPACES: "false" }, extendEnv: true },
                ),
              )
              .pipe(Effect.mapError(packageError));
            const [output, exit] = yield* Effect.all(
              [
                handle.all.pipe(
                  Stream.decodeText(),
                  Stream.runFold(
                    () => "",
                    (result, chunk) => (result + chunk).slice(-4000),
                  ),
                ),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            ).pipe(Effect.mapError(packageError));
            if (exit !== 0)
              return yield* packageError(`Widget package manager exited ${exit}: ${output}`);
          }),
        );
      });
      return WidgetPackages.of({
        directory,
        list: Effect.fn("WidgetPackages.list")(() => lock.withPermits(1)(listUnlocked())),
        install: Effect.fn("WidgetPackages.install")((specifier) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const validated = yield* Schema.decodeUnknownEffect(WidgetPackageSpecifier)(
                specifier,
              ).pipe(Effect.mapError(packageError));
              yield* runNpm(["install", "--save-exact", validated]);
              return yield* listUnlocked();
            }),
          ),
        ),
        remove: Effect.fn("WidgetPackages.remove")((name) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const validated = yield* Schema.decodeUnknownEffect(WidgetPackageName)(name).pipe(
                Effect.mapError(packageError),
              );
              yield* runNpm(["uninstall", validated]);
              return yield* listUnlocked();
            }),
          ),
        ),
      });
    }),
  );
