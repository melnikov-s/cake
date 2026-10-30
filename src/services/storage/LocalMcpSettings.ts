import { randomBytes } from "node:crypto";
import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import {
  LocalMcpConfiguration,
  LocalMcpError,
  defaultLocalMcpConfiguration,
} from "../../contracts/mcp/local-mcp";
import { atomicWriteFile } from "./internal/atomicFile";

const Document = Schema.Struct({
  version: Schema.Literal(2),
  configuration: LocalMcpConfiguration,
  token: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export interface LocalMcpDocument extends Schema.Schema.Type<typeof Document> {}
const StoredDocument = Schema.Struct({
  ...Document.fields,
  version: Schema.Literals([1, 2]),
  configuration: Schema.Struct({
    ...LocalMcpConfiguration.fields,
    port: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 65535 })),
  }),
});
const storageError = (cause: { readonly message: string }) =>
  new LocalMcpError({
    code: "operation_failed",
    message: `Could not access MCP server settings: ${cause.message}`,
  });

export class LocalMcpSettings extends Context.Service<
  LocalMcpSettings,
  {
    readonly load: () => Effect.Effect<LocalMcpDocument, LocalMcpError>;
    readonly save: (document: LocalMcpDocument) => Effect.Effect<void, LocalMcpError>;
  }
>()("cake/services/storage/LocalMcpSettings") {}

export const makeLocalMcpSettingsLive = (directory: string) =>
  Layer.effect(
    LocalMcpSettings,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const target = path.join(directory, "mcp-server.json");
      const save = Effect.fn("LocalMcpSettings.save")(function* (document: LocalMcpDocument) {
        const content = yield* Schema.encodeEffect(Schema.fromJsonString(Document))(document).pipe(
          Effect.mapError(storageError),
        );
        yield* atomicWriteFile(
          fs,
          path,
          target,
          content,
          (stage) =>
            new LocalMcpError({
              code: "operation_failed",
              message: `Could not save MCP server settings (${stage}).`,
            }),
        );
      });
      const load = Effect.fn("LocalMcpSettings.load")(function* () {
        if (!(yield* fs.exists(target).pipe(Effect.mapError(storageError)))) {
          const document: LocalMcpDocument = {
            version: 2,
            configuration: defaultLocalMcpConfiguration(),
            token: randomBytes(32).toString("hex"),
          };
          yield* save(document);
          return document;
        }
        const text = yield* fs.readFileString(target).pipe(Effect.mapError(storageError));
        const document = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredDocument))(
          text,
        ).pipe(Effect.mapError(storageError));
        if (document.version === 2 && document.configuration.port !== 0)
          return { ...document, version: 2 } satisfies LocalMcpDocument;
        // An old read-only/scoped grant must not silently become full control.
        const migrated: LocalMcpDocument = {
          version: 2,
          configuration: {
            enabled: document.version === 2 && document.configuration.enabled,
            port: document.configuration.port || defaultLocalMcpConfiguration().port,
          },
          token: document.token,
        };
        yield* save(migrated);
        return migrated;
      });
      return LocalMcpSettings.of({ load, save });
    }),
  );
