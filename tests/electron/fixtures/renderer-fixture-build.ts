import type { Plugin } from "esbuild";

/**
 * esbuild plugin for isolated renderer fixtures bundled outside Vite. Renderer Stores lazily
 * import the dev-only r-state-tree inspector, whose `virtual:` module only Vite's plugin
 * provides, and `?url` asset imports need Vite's URL rewriting.
 */
export const rendererFixturePlugin: Plugin = {
  name: "renderer-fixture",
  setup(builder) {
    builder.onResolve({ filter: /^virtual:r-state-tree-inspector$/ }, () => ({
      path: "inspector",
      namespace: "fixture-inspector",
    }));
    builder.onLoad({ filter: /.*/, namespace: "fixture-inspector" }, () => ({
      contents: "export const token = undefined;",
      loader: "js",
    }));
    builder.onResolve({ filter: /\?url$/ }, ({ path }) => ({ path, namespace: "asset-url" }));
    builder.onLoad({ filter: /.*/, namespace: "asset-url" }, ({ path }) => ({
      contents: `export default ${JSON.stringify(path)}`,
      loader: "js",
    }));
  },
};
