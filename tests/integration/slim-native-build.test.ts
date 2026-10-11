import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repository = resolve(import.meta.dirname, "../..");

describe("slim native build entry points", () => {
  it.each(["build-dictation.mjs", "build-speech.mjs"])(
    "%s does not probe or invoke Swift even with stale native output",
    async (script) => {
      const root = await mkdtemp(join(tmpdir(), "cake-slim-native-"));
      try {
        const bin = join(root, "bin");
        const output = join(root, "native");
        const marker = join(root, "native-invoked");
        await mkdir(bin);
        await mkdir(output);
        await writeFile(join(output, "cake-speech"), "previous full build");
        const compiler = join(bin, "xcrun");
        await writeFile(compiler, '#!/bin/sh\necho invoked > "$BLOCK_NATIVE_MARKER"\nexit 72\n');
        await chmod(compiler, 0o755);
        const result = await execute(
          process.execPath,
          [join(repository, "scripts", script), output],
          {
            env: {
              ...process.env,
              CAKE_BUILD_MODE: "slim",
              CAKE_NATIVE_CACHE: join(root, "cache"),
              PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
              BLOCK_NATIVE_MARKER: marker,
            },
          },
        );
        expect(result.stdout).toContain("Slim build: skipping native");
        await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(join(output, "cake-speech"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
