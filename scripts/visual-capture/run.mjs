import { build } from "esbuild";
import { queueElectronEntrypoint } from "../electron-run-queue.mjs";

await queueElectronEntrypoint();
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// Native type stripping cannot resolve the app's extensionless source imports.
// Compile the existing harness, retaining its directory-relative paths and CLI.
const output = join(import.meta.dirname, `.compiled-cli-${process.pid}.mjs`);
try {
  await build({
    entryPoints: [join(import.meta.dirname, "cli.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    packages: "external",
    // Keep the queue shim's import.meta.url anchored in scripts/, not this bundled CLI.
    external: ["../queued-electron.mjs"],
    format: "esm",
    logLevel: "silent",
  });
  await import(pathToFileURL(output).href);
} finally {
  // esbuild emits a sibling stylesheet when the bundle imports CSS.
  const stylesheet = output.replace(/\.mjs$/, ".css");
  await Promise.all(
    [output, stylesheet].map((path) =>
      unlink(path).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ),
  );
}
