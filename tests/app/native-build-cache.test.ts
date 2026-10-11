import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildNativeBundle } from "../../scripts/native-build-cache.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cake-native-cache-"));
  roots.push(root);
  const packagePath = join(root, "native"),
    output = join(root, "out");
  const sources = join(packagePath, "Sources"),
    source = join(sources, "main.swift");
  const manifest = join(packagePath, "Package.swift"),
    pins = join(packagePath, "Package.resolved");
  const script = join(root, "build.mjs"),
    assets = join(root, "assets.json");
  await mkdir(sources, { recursive: true });
  for (const path of [source, manifest, pins, script, assets]) await writeFile(path, path);
  // Fake only Swift compilation/packaging. Keep real source hashing, artifact
  // verification, failed-build policy and restoration into disposable output.
  const build = vi.fn<(directory: string, scratch: string) => Promise<void>>(async (directory) => {
    await writeFile(join(directory, "cake-helper"), "compiled binary");
    await chmod(join(directory, "cake-helper"), 0o755);
    await mkdir(join(directory, "Models.bundle"));
    await writeFile(join(directory, "Models.bundle", "model.bin"), "bundled model");
    await writeFile(join(directory, "LICENSE"), "bundled license");
  });
  const cacheRoot = join(root, "shared-cache");
  const options = {
    cacheRoot,
    output,
    product: "cake-helper",
    inputs: [sources, manifest, pins, script, assets],
    buildIdentity: "compiler SDK architecture and environment",
    build,
  };
  return {
    root,
    source,
    sources,
    manifest,
    pins,
    script,
    assets,
    output,
    build,
    options,
    cache: join(cacheRoot, "cake-helper", "bundles"),
  };
}

describe("native bundle build cache", () => {
  it("shares bundles and Swift scratch across identical worktree inputs without a local .build", async () => {
    const f = await fixture();
    const second = await fixture();
    for (let index = 0; index < f.options.inputs.length; index++) {
      await rm(second.options.inputs[index]!, { recursive: true, force: true });
      await cp(f.options.inputs[index]!, second.options.inputs[index]!, { recursive: true });
    }
    await buildNativeBundle(f.options);
    await buildNativeBundle({ ...second.options, cacheRoot: f.options.cacheRoot });
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(second.build).not.toHaveBeenCalled();
    expect(await readFile(join(second.output, "cake-helper"), "utf8")).toBe("compiled binary");
    const scratch = f.build.mock.calls[0]?.[1];
    expect(scratch).toContain(join(f.options.cacheRoot, "cake-helper", "scratch"));
    expect(await readdir(join(f.root, "native"))).not.toContain(".build");
    expect(await readdir(join(second.root, "native"))).not.toContain(".build");
  });
  it("serializes concurrent identical builds and restages both outputs from one compilation", async () => {
    const f = await fixture();
    await Promise.all([
      buildNativeBundle(f.options),
      buildNativeBundle({ ...f.options, output: join(f.root, "second-output") }),
    ]);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.root, "second-output", "cake-helper"), "utf8")).toBe(
      "compiled binary",
    );
    expect(await readdir(join(f.options.cacheRoot, "cake-helper", "locks"))).toEqual([]);
  });
  it("isolates changed native inputs from an existing shared entry", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    const original = await readFile(f.source);
    const originalScratch = f.build.mock.calls[0]?.[1];
    await writeFile(f.source, "different native source");
    await buildNativeBundle(f.options);
    expect(f.build.mock.calls[1]?.[1]).not.toBe(originalScratch);
    expect(await readdir(f.cache)).toHaveLength(2);
    await writeFile(f.source, original);
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(2);
  });
  it("reuses unchanged native inputs and restores all artifacts after out/ is deleted", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    await rm(f.output, { recursive: true });
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.output, "cake-helper"), "utf8")).toBe("compiled binary");
    expect((await stat(join(f.output, "cake-helper"))).mode & 0o777).toBe(0o755);
    expect(await readFile(join(f.output, "Models.bundle", "model.bin"), "utf8")).toBe(
      "bundled model",
    );
    expect(await readFile(join(f.output, "LICENSE"), "utf8")).toBe("bundled license");
  });
  it("restaging removes obsolete resource files without deleting another helper's output", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    const obsolete = join(f.output, "Models.bundle", "old.bin");
    await writeFile(obsolete, "obsolete resource");
    await writeFile(join(f.output, "other-helper"), "another native product");
    await buildNativeBundle(f.options);
    expect(await readdir(join(f.output, "Models.bundle"))).toEqual(["model.bin"]);
    expect(await readFile(join(f.output, "other-helper"), "utf8")).toBe("another native product");
    expect(f.build).toHaveBeenCalledTimes(1);
  });
  it("ignores timestamp-only source changes and unrelated renderer changes", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    await utimes(f.source, new Date(0), new Date(0));
    await writeFile(join(f.root, "renderer.ts"), "new renderer code");
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(1);
  });
  it.each(["source", "manifest", "pins", "script", "assets"] as const)(
    "rebuilds when %s content changes even with its old timestamp",
    async (input) => {
      const f = await fixture();
      await buildNativeBundle(f.options);
      const previous = await stat(f[input]);
      await writeFile(f[input], "changed input");
      await utimes(f[input], previous.atime, previous.mtime);
      await buildNativeBundle(f.options);
      expect(f.build).toHaveBeenCalledTimes(2);
    },
  );
  it("invalidates on source addition/deletion and toolchain changes", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    const added = join(f.sources, "new.swift");
    await writeFile(added, "new Swift source");
    await buildNativeBundle(f.options);
    await rm(added);
    await buildNativeBundle(f.options);
    await buildNativeBundle({ ...f.options, buildIdentity: "new compiler or SDK" });
    // Returning to a previously built content key reuses that entry.
    expect(f.build).toHaveBeenCalledTimes(3);
  });
  it.each(["missing", "corrupt", "permissions", "manifest"])(
    "rebuilds an invalid cached artifact (%s)",
    async (damage) => {
      const f = await fixture();
      await buildNativeBundle(f.options);
      const [key] = await readdir(f.cache);
      const entry = join(f.cache, key!);
      const binary = join(entry, "bundle", "cake-helper");
      if (damage === "missing") await rm(binary);
      if (damage === "corrupt") await writeFile(binary, "broken binary");
      if (damage === "permissions") await chmod(binary, 0o644);
      if (damage === "manifest") await writeFile(join(entry, "manifest.json"), "invalid JSON");
      await buildNativeBundle(f.options);
      expect(f.build).toHaveBeenCalledTimes(2);
      expect(await readFile(join(f.output, "cake-helper"), "utf8")).toBe("compiled binary");
    },
  );
  it("allows explicit cache bypass without changing native inputs", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    await buildNativeBundle({ ...f.options, force: true });
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(2);
  });
  it("does not cache failed builds and keeps the last successful entry intact", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    const original = await readFile(f.source);
    await writeFile(f.source, "changed source");
    f.build.mockImplementationOnce(async (directory) => {
      await writeFile(join(directory, "cake-helper"), "incomplete binary");
      throw new Error("compiler failed");
    });
    await expect(buildNativeBundle(f.options)).rejects.toThrow("compiler failed");
    expect((await readdir(f.cache)).some((path) => path.startsWith(".staged-"))).toBe(false);
    await writeFile(f.source, original);
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(2);
    await writeFile(f.source, "changed source");
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(3);
  });
  it("keeps a successful shared entry when a forced rebuild fails and releases its lock", async () => {
    const f = await fixture();
    await buildNativeBundle(f.options);
    f.build.mockRejectedValueOnce(new Error("forced compiler failure"));
    await expect(buildNativeBundle({ ...f.options, force: true })).rejects.toThrow(
      "forced compiler failure",
    );
    await rm(f.output, { recursive: true });
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(2);
    expect(await readFile(join(f.output, "cake-helper"), "utf8")).toBe("compiled binary");
    expect(await readdir(join(f.options.cacheRoot, "cake-helper", "locks"))).toEqual([]);
  });
  it("refuses to cache output built while its inputs were changing", async () => {
    const f = await fixture();
    const build = async (directory: string, scratch: string) => {
      await f.build(directory, scratch);
      await writeFile(f.source, "edited during compilation");
    };
    await expect(buildNativeBundle({ ...f.options, build })).rejects.toThrow(
      "Native inputs changed",
    );
    await buildNativeBundle(f.options);
    expect(f.build).toHaveBeenCalledTimes(2);
  });
});
