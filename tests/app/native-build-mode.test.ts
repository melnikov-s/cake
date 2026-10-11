import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNativeAssets, nativeBuildMode } from "../../scripts/native-build-mode.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native build modes", () => {
  it("keeps normal builds full and rejects an unknown mode", () => {
    expect(nativeBuildMode({})).toBe("full");
    expect(nativeBuildMode({ CAKE_BUILD_MODE: "slim" })).toBe("slim");
    expect(() => nativeBuildMode({ CAKE_BUILD_MODE: "typo" })).toThrow("Choose full or slim");
  });
  it("full builds invoke both native builders in order", async () => {
    const run = vi.fn(async () => undefined);
    await buildNativeAssets("/output/native", run, { CAKE_BUILD_MODE: "full" });
    expect(run.mock.calls).toEqual([
      ["build-dictation.mjs", "/output/native"],
      ["build-speech.mjs", "/output/native"],
    ]);
  });
  it.each([false, true])(
    "slim skips every native builder even with existing native output: %s",
    async (warm) => {
      const root = await mkdtemp(join(tmpdir(), "cake-slim-build-"));
      roots.push(root);
      const output = join(root, "out", "native");
      const cache = join(root, "cache");
      await mkdir(cache);
      await writeFile(join(cache, "native-bundle"), "cached full feature bundle");
      if (warm) {
        await mkdir(output, { recursive: true });
        await writeFile(join(output, "cake-dictation"), "stale helper");
        await writeFile(join(output, "cake-speech"), "stale helper");
      }
      const run = vi.fn(async () => {
        throw new Error("Slim must not invoke native tools or downloads");
      });
      await buildNativeAssets(output, run, { CAKE_BUILD_MODE: "slim" });
      expect(run).not.toHaveBeenCalled();
      await expect(readFile(join(output, "cake-speech"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(output, "cake-dictation"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(cache, "native-bundle"), "utf8")).toBe(
        "cached full feature bundle",
      );
    },
  );
});
