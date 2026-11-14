import { transform } from "esbuild";
import type { Plugin } from "vite";

// Vite 8 lowers standard decorators during production bundling, but leaves them in dev/SSR.
// Keep the esbuild lowering Cake used before Vite 8. Place after inspector source metadata.
export function standardDecorators(): Plugin {
  return {
    name: "cake-standard-decorators",
    enforce: "pre",
    async transform(source, id) {
      const file = id.split("?")[0] ?? id;
      if (file.includes("/node_modules/") || !/\.tsx?$/.test(file) || !source.includes("@")) return;
      const result = await transform(source, {
        sourcefile: file,
        loader: file.endsWith(".tsx") ? "tsx" : "ts",
        target: "es2022",
        jsx: "automatic",
        sourcemap: true,
        tsconfigRaw: {
          compilerOptions: { experimentalDecorators: false, useDefineForClassFields: true },
        },
      });
      return { code: result.code, map: result.map };
    },
  };
}
