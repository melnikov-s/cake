import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import process from "node:process";

import { buildIdentity } from "./build-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Bundle Cake source and raw prompts; reuse the installed Node dependencies. */
export const serverBuildOptions = {
  absWorkingDir: root,
  define: { __CAKE_BUILD_ID__: JSON.stringify(buildIdentity()) },
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  plugins: [
    {
      name: "raw-prompts",
      setup(builder) {
        builder.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: resolve(args.resolveDir, args.path.slice(0, -4)),
          namespace: "raw",
        }));
        builder.onLoad({ filter: /.*/, namespace: "raw" }, async (args) => ({
          contents: await readFile(args.path, "utf8"),
          loader: "text",
        }));
      },
    },
  ],
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await build({
    ...serverBuildOptions,
    entryPoints: ["src/server/main.ts"],
    outfile: "out/server/main.mjs",
    sourcemap: true,
  });
}
