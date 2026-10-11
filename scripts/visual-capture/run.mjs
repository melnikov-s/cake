import { build } from "esbuild";
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
    format: "esm",
    logLevel: "silent",
  });
  await import(pathToFileURL(output).href);
} finally {
  await unlink(output).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
