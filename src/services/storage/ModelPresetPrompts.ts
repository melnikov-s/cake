import { Context, Effect, FileSystem, Layer, Path } from "effect";
import { ModelPresetValidationError } from "../../contracts/model-presets/model-preset-data";
import { atomicWriteFile } from "./internal/atomicFile";

/** Markdown files are authoritative; application state stores only their absolute references. */
export class ModelPresetPrompts extends Context.Service<
  ModelPresetPrompts,
  {
    readonly read: (promptFile: string) => Effect.Effect<string, ModelPresetValidationError>;
    readonly write: (
      prompt: string,
      promptFile?: string,
    ) => Effect.Effect<string, ModelPresetValidationError>;
  }
>()("cake/services/storage/ModelPresetPrompts") {}

export const makeModelPresetPrompts = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  directory: string,
): ModelPresetPrompts["Service"] => {
  const root = path.resolve(directory);
  const validate = Effect.fn("ModelPresetPrompts.validate")(function* (promptFile: string) {
    const resolved = path.resolve(promptFile);
    const relative = path.relative(root, resolved);
    if (
      !path.isAbsolute(promptFile) ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      path.extname(resolved).toLowerCase() !== ".md"
    )
      return yield* new ModelPresetValidationError({
        message: `Preset prompt file must be a Markdown file under ${root}: ${promptFile}`,
      });
    return resolved;
  });
  const read = Effect.fn("ModelPresetPrompts.read")(function* (promptFile: string) {
    const file = yield* validate(promptFile);
    return yield* fs.readFileString(file).pipe(
      Effect.mapError(
        (cause) =>
          new ModelPresetValidationError({
            message: `Could not read preset prompt ${file}: ${cause.message}`,
          }),
      ),
    );
  });
  const write = Effect.fn("ModelPresetPrompts.write")(function* (
    prompt: string,
    promptFile?: string,
  ) {
    const file = yield* validate(promptFile ?? path.join(root, `${crypto.randomUUID()}.md`));
    yield* atomicWriteFile(
      fs,
      path,
      file,
      prompt,
      (_stage, cause) =>
        new ModelPresetValidationError({
          message: `Could not write preset prompt ${file}: ${String(cause)}`,
        }),
    );
    return file;
  });
  return ModelPresetPrompts.of({ read, write });
};

export const makeModelPresetPromptsLive = (directory: string) =>
  Layer.effect(
    ModelPresetPrompts,
    Effect.gen(function* () {
      return makeModelPresetPrompts(yield* FileSystem.FileSystem, yield* Path.Path, directory);
    }),
  );
