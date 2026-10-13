import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { Schema } from "effect";
import type { Plugin } from "esbuild";

export interface WidgetBrowserAsset {
  readonly path: string;
  readonly contentType: string;
  readonly data: Uint8Array;
}

export interface WidgetCompileOptions {
  readonly packageDirectory?: string;
}

const Manifest = Schema.Struct({
  dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const coreRuntime = /^(?:react|react-dom)(?:\/.*)?$/;
const coreDirectories = ["react", "react-dom"].map((name) =>
  dirname(fileURLToPath(import.meta.resolve(`${name}/package.json`))),
);
coreDirectories.push(
  dirname(createRequire(import.meta.resolve("react-dom/client")).resolve("scheduler/package.json")),
);
const packageName = (specifier: string) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? "");
const within = (root: string, target: string) => {
  const path = relative(root, target);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
};

function widgetAssetContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".ttf":
      return "font/ttf";
    case ".otf":
      return "font/otf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    default:
      return "application/octet-stream";
  }
}

/** All third-party resolution starts in the user environment, never Cake node_modules. */
export async function widgetPackageResolver(
  options: WidgetCompileOptions,
  token: string,
): Promise<{ plugin: Plugin; assets: WidgetBrowserAsset[] }> {
  const assets: WidgetBrowserAsset[] = [];
  const root = options.packageDirectory
    ? await realpath(options.packageDirectory).catch(() => undefined)
    : undefined;
  const moduleRoot = root ? join(root, "node_modules") : undefined;
  const dependencies = root
    ? (Schema.decodeUnknownSync(Schema.fromJsonString(Manifest))(
        await readFile(join(root, "package.json"), "utf8"),
      ).dependencies ?? {})
    : {};
  const declared = (specifier: string) => {
    if (!Object.hasOwn(dependencies, packageName(specifier)))
      throw new Error(
        `Widget package ${JSON.stringify(packageName(specifier))} is not installed. Ask the user before installing dependencies.`,
      );
  };
  let assetIndex = 0;
  let assetBytes = 0;
  const plugin: Plugin = {
    name: "cake-widget-packages",
    setup(builder) {
      builder.onResolve({ filter: coreRuntime }, (args) => ({
        path: fileURLToPath(import.meta.resolve(args.path)),
      }));
      builder.onResolve({ filter: /^@cake\/assets\// }, async (args) => {
        const specifier = args.path.slice("@cake/assets/".length);
        declared(specifier);
        const name = packageName(specifier);
        const subpath = specifier.slice(name.length + 1);
        if (
          !moduleRoot ||
          !args.path.endsWith("/") ||
          subpath.split("/").some((part) => part === ".." || part === ".") ||
          subpath.includes("\\")
        )
          throw new Error(
            "Widget asset imports must name an installed package directory and end in /",
          );
        const packageRoot = await realpath(join(moduleRoot, name));
        if (!within(moduleRoot, packageRoot))
          throw new Error(
            "Widget runtime assets cannot resolve outside the shared package environment",
          );
        const directory = await realpath(join(packageRoot, subpath));
        if (!within(packageRoot, directory) || !(await stat(directory)).isDirectory())
          throw new Error("Widget assets must stay inside their installed package");
        const prefix = `assets/${assetIndex++}/`;
        const visit = async (current: string) => {
          for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
            a.name.localeCompare(b.name),
          )) {
            const target = join(current, entry.name);
            if (entry.isSymbolicLink())
              throw new Error("Widget runtime assets cannot contain symlinks");
            if (entry.isDirectory()) await visit(target);
            else if (entry.isFile()) {
              const data = await readFile(target);
              assetBytes += data.byteLength;
              if (assetBytes > 64 * 1024 * 1024 || assets.length >= 10_000)
                throw new Error("Widget runtime assets exceed the 64 MiB / 10,000 file limit");
              const path = prefix + relative(directory, target).split(sep).join("/");
              assets.push({ path, contentType: widgetAssetContentType(path), data });
            }
          }
        };
        await visit(directory);
        return { path: `./${token}/${prefix}`, namespace: "cake-widget-assets" };
      });
      builder.onLoad({ filter: /.*/, namespace: "cake-widget-assets" }, (args) => ({
        contents: `export default new URL(${JSON.stringify(args.path)}, location.href).href;`,
        loader: "js",
      }));
      builder.onResolve({ filter: /.*/ }, async (args) => {
        if (
          args.path.startsWith("cake:") ||
          /^@cake\/(?:plugin-sdk|artifact-sdk)$/.test(args.path) ||
          args.namespace === "cake-widget-assets" ||
          args.pluginData?.cakePackageResolution
        )
          return;
        if (
          args.namespace === "cake-widget" ||
          args.namespace === "cake-plugin-sdk" ||
          args.namespace === "cake-artifact-sdk" ||
          args.importer.endsWith("cake-widget-entry.tsx")
        ) {
          if (/^(?:\.|\/|[a-z]+:)/i.test(args.path))
            throw new Error(
              "Widget source may import installed package names only, not files or URLs",
            );
          declared(args.path);
        }
        if (
          args.namespace === "file" &&
          coreDirectories.some((directory) => within(directory, args.importer))
        )
          return;
        if (!moduleRoot)
          throw new Error(
            `Widget dependency ${JSON.stringify(args.path)} requires a user-installed widget package environment`,
          );
        const resolution = await builder.resolve(args.path, {
          kind: args.kind,
          resolveDir:
            args.namespace === "cake-widget" ? (root ?? "") : args.resolveDir || (root ?? ""),
          pluginData: { cakePackageResolution: true },
        });
        if (resolution.errors.length || resolution.external) return resolution;
        const target = await realpath(resolution.path);
        if (!within(moduleRoot, target))
          throw new Error(
            "Widget dependencies cannot resolve outside the shared widget package environment",
          );
        return { path: target };
      });
    },
  };
  return { plugin, assets };
}
