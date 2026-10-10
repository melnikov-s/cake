import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSettings } from "../../../../src/services/pi/PiSettings";
import { makePiSettingsLive } from "../../../../src/services/pi/live/PiSettingsLive";

const roots: string[] = [];
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
async function fixture(settings: object = {}) {
  const root = await mkdtemp(join(tmpdir(), "cake-pi-extensions-"));
  roots.push(root);
  vi.stubEnv("PI_CODING_AGENT_DIR", root);
  await mkdir(join(root, "extensions"));
  await writeFile(
    join(root, "extensions", "auto.ts"),
    "throw new Error('Discovery must not execute extension code');",
  );
  await writeFile(
    join(root, "settings.json"),
    JSON.stringify({ ...settings, unrelated: { retained: true } }),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, PiSettings>) =>
    Effect.runPromise(
      effect.pipe(Effect.provide(makePiSettingsLive(root).pipe(Layer.provide(platform)))),
    );
  return {
    root,
    run,
    list: () => run(Effect.flatMap(PiSettings, (service) => service.extensions())),
    toggle: (id: string, enabled: boolean) =>
      run(Effect.flatMap(PiSettings, (service) => service.setExtensionEnabled({ id, enabled }))),
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Pi extension settings", () => {
  it("discovers automatic and builtin extensions without executing them; native toggles survive Pi reload", async () => {
    const { root, list, toggle } = await fixture({
      extensions: ["-extensions/auto.ts", "-builtin:mcp"],
    });
    const original = await readFile(join(root, "settings.json"), "utf8");
    const entries = await list();
    expect(entries.find((entry) => entry.name === "auto.ts")?.enabled).toBe(false);
    expect(entries.find((entry) => entry.id === "builtin:mcp")?.enabled).toBe(false);
    expect(await readFile(join(root, "settings.json"), "utf8")).toBe(original);
    await toggle(join(root, "extensions", "auto.ts"), true);
    await toggle("builtin:mcp", true);
    const manager = SettingsManager.create(root, root, { projectTrusted: false });
    expect(manager.getExtensionPaths()).toEqual(["+extensions/auto.ts", "+builtin:mcp"]);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8")).unrelated).toEqual({
      retained: true,
    });
    await toggle(join(root, "extensions", "auto.ts"), false);
    expect((await list()).find((entry) => entry.name === "auto.ts")?.enabled).toBe(false);
    expect((await list()).find((entry) => entry.id === "builtin:mcp")?.enabled).toBe(true);
  });

  it("toggles package extension filters without replacing the package or disabling its other resources", async () => {
    const { root, list, toggle } = await fixture();
    const packageRoot = join(root, "fixture-package");
    await mkdir(packageRoot);
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture", pi: { extensions: ["a.ts", "b.ts"] } }),
    );
    for (const name of ["a.ts", "b.ts"])
      await writeFile(
        join(packageRoot, name),
        "throw new Error('Must not execute package extensions');",
      );
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify({
        packages: [{ source: packageRoot, skills: ["!*"], prompts: [] }],
        unrelated: true,
      }),
    );
    const a = join(packageRoot, "a.ts");
    await toggle(a, false);
    expect((await list()).find((entry) => entry.id === a)?.enabled).toBe(false);
    expect((await list()).find((entry) => entry.name === "b.ts")?.enabled).toBe(true);
    expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
      packages: [{ source: packageRoot, skills: ["!*"], prompts: [], extensions: ["-a.ts"] }],
      unrelated: true,
    });
    await toggle(a, true);
    expect((await list()).find((entry) => entry.id === a)?.enabled).toBe(true);
  });

  it("rejects stale or arbitrary IDs and malformed settings without writing configuration", async () => {
    const { root, toggle } = await fixture();
    const document = join(root, "settings.json");
    const original = await readFile(document, "utf8");
    await expect(toggle(join(root, "not-discovered.ts"), false)).rejects.toThrow(
      "no longer discoverable",
    );
    expect(await readFile(document, "utf8")).toBe(original);
    await writeFile(document, "{ invalid settings");
    await expect(toggle("builtin:mcp", false)).rejects.toThrow();
    expect(await readFile(document, "utf8")).toBe("{ invalid settings");
  });
});
