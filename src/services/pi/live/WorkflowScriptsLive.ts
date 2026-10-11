import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import {
  WorkflowError,
  WorkflowMeta,
  WorkflowProgram,
  type SavedWorkflow,
} from "../../../contracts/workflows/workflow-data";
import { WorkflowScripts, type WorkflowScriptLocation } from "../WorkflowScripts";
import { parseWorkflowProgram } from "../runtime/workflow-program";

const failure = (operation: string, error: unknown) =>
  error instanceof WorkflowError
    ? error
    : new WorkflowError({
        operation,
        reason: "script",
        message: error instanceof Error ? error.message : String(error),
      });

export const makeWorkflowScriptsLive = (personalDirectory: string) =>
  Layer.effect(
    WorkflowScripts,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parse = Effect.fn("WorkflowScripts.parse")(function* (source: string) {
        return yield* Effect.try({
          try: () => parseWorkflowProgram(source),
          catch: (error) => failure("parse", error),
        });
      });
      const read = Effect.fn("WorkflowScripts.read")(function* (
        location: WorkflowScriptLocation,
        scriptPath: string,
        args?: Schema.Schema.Type<typeof Schema.Json>,
      ) {
        const target = path.resolve(location.workingDirectory, scriptPath);
        const source = yield* fs
          .readFileString(target)
          .pipe(Effect.mapError((error) => failure("read", error)));
        const parsed = yield* parse(source);
        const program: WorkflowProgram = { meta: parsed.meta, source, sourcePath: target };
        if (args !== undefined) Object.assign(program, { args });
        return yield* Schema.decodeUnknownEffect(WorkflowProgram)(program).pipe(
          Effect.mapError((error) => failure("read", error)),
        );
      });
      const directories = (location: WorkflowScriptLocation) => {
        const result: string[] = [];
        let current = path.resolve(location.workingDirectory);
        const root = path.resolve(location.projectPath);
        // Managed worktrees are outside the Project root: do not search unrelated ancestors.
        if (
          current !== root &&
          (path.relative(root, current).startsWith("..") ||
            path.isAbsolute(path.relative(root, current)))
        )
          return [path.join(current, ".cake", "workflows")];
        for (;;) {
          result.push(path.join(current, ".cake", "workflows"));
          if (current === root || path.dirname(current) === current) break;
          current = path.dirname(current);
        }
        return result;
      };
      const list = Effect.fn("WorkflowScripts.list")(function* (location: WorkflowScriptLocation) {
        const found = new Map<string, SavedWorkflow>();
        const scopes = [
          ...directories(location).map((directory) => ({
            directory,
            location: "project" as const,
          })),
          { directory: personalDirectory, location: "personal" as const },
        ];
        for (const scope of scopes) {
          if (
            !(yield* fs
              .exists(scope.directory)
              .pipe(Effect.mapError((error) => failure("list", error))))
          )
            continue;
          const names = yield* fs
            .readDirectory(scope.directory)
            .pipe(Effect.mapError((error) => failure("list", error)));
          for (const name of names.filter((item) => item.endsWith(".js")).sort()) {
            const program = yield* read(location, path.join(scope.directory, name));
            if (!found.has(program.meta.name))
              found.set(program.meta.name, {
                meta: program.meta,
                path: program.sourcePath,
                location: scope.location,
              });
          }
        }
        return [...found.values()];
      });
      const refuseLink = Effect.fn("WorkflowScripts.refuseLink")(function* (target: string) {
        const link = yield* fs.readLink(target).pipe(Effect.option);
        if (link._tag === "Some")
          return yield* failure("save", `Refusing symlink save location: ${target}`);
      });
      const save = Effect.fn("WorkflowScripts.save")(function* (
        location: WorkflowScriptLocation,
        program: WorkflowProgram,
        name: string,
        destination: "project" | "personal",
      ) {
        const meta = yield* Schema.decodeUnknownEffect(WorkflowMeta)({
          ...program.meta,
          name,
        }).pipe(Effect.mapError((error) => failure("save", error)));
        const candidates = directories(location);
        let directory = personalDirectory;
        if (destination === "project") {
          directory = candidates.at(-1) ?? path.join(location.projectPath, ".cake", "workflows");
          for (const candidate of candidates)
            if (
              yield* fs.exists(candidate).pipe(Effect.mapError((error) => failure("save", error)))
            ) {
              directory = candidate;
              break;
            }
          const cakeDirectory = path.dirname(directory);
          for (const candidate of [cakeDirectory, directory]) {
            yield* refuseLink(candidate);
          }
        }
        const target = path.join(directory, `${name}.js`);
        // readLink is used separately: exists/stat implementations can follow dangling links.
        const link = yield* fs.readLink(target).pipe(Effect.option);
        if (link._tag === "Some")
          return yield* failure("save", `Refusing symlink save target: ${target}`);
        const parsed = yield* parse(program.source);
        const source = `export const meta = ${JSON.stringify(meta, null, 2)};${program.source.slice(parsed.metaEnd)}`;
        yield* fs
          .makeDirectory(directory, { recursive: true, mode: 0o700 })
          .pipe(Effect.mapError((error) => failure("save", error)));
        // Never follow a target symlink, even if it appears after the preflight check.
        yield* fs
          .writeFileString(target, source, { flag: "wx", mode: 0o600 })
          .pipe(Effect.mapError((error) => failure("save", error)));
        return { meta, path: target, location: destination } satisfies SavedWorkflow;
      });
      return WorkflowScripts.of({ read, list, save });
    }),
  );
