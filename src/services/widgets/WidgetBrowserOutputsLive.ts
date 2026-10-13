import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
import { InlineWidgetError } from "../../contracts/widgets/inline-widgets-errors";
import { WidgetBrowserOutputs } from "./WidgetBrowserOutputs";
import type { CompiledInlineWidgetDocument } from "./inline-widget-service";

const tokenPlaceholder = "__CAKE_WIDGET_TOKEN__";
const maxBuildBytes = 96 * 1024 * 1024;
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const AssetMetadata = Schema.Struct({
  path: Schema.String.check(
    Schema.isMaxLength(4096),
    Schema.isPattern(/^assets\/[0-9]+\/[^\\?#:]+$/),
    Schema.makeFilter((value) =>
      value.split("/").every((part) => part !== "" && part !== "." && part !== "..") &&
      Array.from(value).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code > 31 && code !== 127;
      })
        ? undefined
        : "Asset paths must be canonical relative paths",
    ),
  ),
  contentType: Schema.String.check(Schema.isMaxLength(128)),
  digest: WidgetBrowserOutput.fields.digest,
});
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  documentDigest: WidgetBrowserOutput.fields.digest,
  assets: Schema.Array(AssetMetadata).check(Schema.isMaxLength(10_000)),
});
const error = (operation: string, cause: unknown) =>
  new InlineWidgetError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

/** Content-addressed, write-once browser files. Reopening never consults packages or compiler. */
export const makeWidgetBrowserOutputsLive = (root: string) =>
  Layer.succeed(
    WidgetBrowserOutputs,
    WidgetBrowserOutputs.of({
      retain: Effect.fn("WidgetBrowserOutputs.retain")((compiled: CompiledInlineWidgetDocument) =>
        Effect.tryPromise({
          try: async () => {
            const document = compiled.document.replaceAll(compiled.token, tokenPlaceholder);
            const assets = compiled.assets ?? [];
            if (
              Buffer.byteLength(document) +
                assets.reduce((sum, item) => sum + item.data.byteLength, 0) >
              maxBuildBytes
            )
              throw new Error("Widget browser output exceeds 96 MiB");
            const manifest = Schema.decodeUnknownSync(Manifest)({
              version: 1,
              documentDigest: sha256(document),
              assets: assets.map(({ path, contentType, data }) => ({
                path,
                contentType,
                digest: sha256(data),
              })),
            });
            const serialized = JSON.stringify(manifest);
            const digest = sha256(serialized);
            await mkdir(root, { recursive: true, mode: 0o700 });
            const temporary = await mkdtemp(join(root, ".build-"));
            try {
              await writeFile(join(temporary, "document.html"), document);
              for (const asset of assets) {
                const target = join(temporary, asset.path);
                await mkdir(dirname(target), { recursive: true });
                await writeFile(target, asset.data);
              }
              await writeFile(join(temporary, "manifest.json"), serialized);
              await rename(temporary, join(root, digest)).catch(async (cause: unknown) => {
                const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.String }))(
                  cause,
                );
                if (code._tag !== "Some" || !["EEXIST", "ENOTEMPTY"].includes(code.value.code))
                  throw cause;
                // Existing immutable build is validated by open before use.
              });
            } finally {
              await rm(temporary, { recursive: true, force: true });
            }
            return { digest };
          },
          catch: (cause) => error("retain-browser-output", cause),
        }),
      ),
      open: Effect.fn("WidgetBrowserOutputs.open")((browser: WidgetBrowserOutput) =>
        Effect.tryPromise({
          try: async () => {
            const { digest } = Schema.decodeUnknownSync(WidgetBrowserOutput)(browser);
            const directory = join(root, digest);
            const serialized = await readFile(join(directory, "manifest.json"), "utf8");
            if (sha256(serialized) !== digest)
              throw new Error("Widget browser output manifest failed integrity verification");
            const manifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(serialized);
            const document = await readFile(join(directory, "document.html"), "utf8");
            if (sha256(document) !== manifest.documentDigest)
              throw new Error("Widget browser document failed integrity verification");
            let bytes = Buffer.byteLength(document);
            const assets = [];
            for (const asset of manifest.assets) {
              const data = await readFile(join(directory, asset.path));
              bytes += data.byteLength;
              if (bytes > maxBuildBytes || sha256(data) !== asset.digest)
                throw new Error("Widget browser resource failed integrity verification");
              assets.push({ path: asset.path, contentType: asset.contentType, data });
            }
            const token = randomUUID();
            return { token, document: document.replaceAll(tokenPlaceholder, token), assets };
          },
          catch: (cause) => error("open-browser-output", cause),
        }),
      ),
    }),
  );
