import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("builds, activates, persists, recovers, and rolls back a plugin renderer", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-plugin-smoke-"));
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  const plugin = join(cakeHome, "plugins", "smoke.example");
  const scenes = join(cakeHome, "scenes");
  await Promise.all([mkdir(plugin, { recursive: true }), mkdir(scenes, { recursive: true }), mkdir(userData, { recursive: true })]);
  await writeFile(join(plugin, "cake-plugin.json"), JSON.stringify({ schemaVersion: 1, id: "smoke.example", name: "Smoke Example", entry: "index.tsx" }));
  const writePlugin = (label: string) => writeFile(join(plugin, "index.tsx"), `import { definePlugin } from "cake"; export default definePlugin({ id: "smoke.example", contributions: { Badge: () => <b>${label}</b> } });\n`);
  await writePlugin("PLUGIN_V1");
  await writeFile(join(scenes, "global.tsx"), `import type { ReactNode } from "react"; import plugin from "plugin:smoke.example"; const Badge = plugin.contributions.Badge; export default function Scene({ children }: { children: ReactNode }) { return <><div id="plugin-marker"><Badge /></div>{children}</>; }\n`);

  const application = await electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData, CAKE_HOME: cakeHome } });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const request = (input: unknown) => page.evaluate(async (payload) => (window as unknown as { cake: { request(value: unknown): Promise<unknown> } }).cake.request(payload), input);
    const build = (input: Record<string, unknown> = {}) => request({ type: "build-customization", ...input });
    await build();
    await expect(page.locator("#plugin-marker")).toContainText("PLUGIN_V1", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { pendingRevision?: string; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state)).toMatchObject({ pendingRevision: undefined, activeRevision: expect.any(String) });

    await page.evaluate(async () => {
      const bridge = (window as unknown as { cake: { request(input: unknown): Promise<{ record?: { value: unknown } }> } }).cake;
      await bridge.request({ type: "save-plugin-state", pluginId: "smoke.example", key: "selection", scope: { kind: "global" }, value: { day: 3 }, expectedVersion: 0 });
      const loaded = await bridge.request({ type: "load-plugin-state", pluginId: "smoke.example", key: "selection", scope: { kind: "global" } });
      if (JSON.stringify(loaded.record?.value) !== JSON.stringify({ day: 3 })) throw new Error("Plugin state did not round-trip");
    });

    const sourceV1 = await request({ type: "get-customization-state" }) as { state: { sourceRevision: string } };
    const filesV1 = await request({ type: "list-customization-files" }) as { workingRevision: string; files: string[] };
    expect(filesV1.files).toContain("plugins/smoke.example/index.tsx");
    expect(await request({ type: "read-customization-file", path: "plugins/smoke.example/index.tsx" })).toMatchObject({ content: expect.stringContaining("PLUGIN_V1") });
    const sourceV2 = `import { definePlugin } from "cake"; export default definePlugin({ id: "smoke.example", contributions: { Badge: () => <b>PLUGIN_V2</b> } });\n`;
    const filesV2 = await request({ type: "write-customization-file", path: "plugins/smoke.example/index.tsx", content: sourceV2, expectedWorkingRevision: filesV1.workingRevision }) as { buildRevision: string };
    await build({ expectedBaseRevision: sourceV1.state.sourceRevision, expectedSourceRevision: filesV2.buildRevision, request: "Upgrade smoke plugin to V2" });
    await expect(page.locator("#plugin-marker")).toContainText("PLUGIN_V2", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { pendingRevision?: string; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state)).toMatchObject({ pendingRevision: undefined, activeRevision: expect.any(String) });
    const activeV2 = await request({ type: "get-customization-state" }) as { state: { sourceRevision: string } };
    const filesBeforeCrash = await request({ type: "list-customization-files" }) as { workingRevision: string };
    const broken = await request({ type: "write-customization-file", path: "scenes/global.tsx", content: `import type { ReactNode } from "react"; export default function Broken(_props: { children: ReactNode }) { throw new Error("PLUGIN_RUNTIME_CRASH"); }\n`, expectedWorkingRevision: filesBeforeCrash.workingRevision }) as { buildRevision: string };
    await build({ expectedBaseRevision: activeV2.state.sourceRevision, expectedSourceRevision: broken.buildRevision, request: "Exercise runtime recovery" });
    await expect(page.locator("[aria-label='Customization recovery']")).toContainText("Cake opened the default interface", { timeout: 20_000 });
    await expect(page.locator("[aria-label='Customization recovery']")).toContainText("Smoke Example didn’t load");
    await expect(page.locator("[aria-label='Customization recovery']")).toContainText("PLUGIN_RUNTIME_CRASH");
    await page.getByRole("button", { name: "Roll back" }).click();
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { recoveryRequired?: boolean; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state)).toMatchObject({ recoveryRequired: false, activeRevision: expect.any(String) });
    await expect(page.locator("#plugin-marker")).toContainText("PLUGIN_V2", { timeout: 20_000 });
  } finally {
    await application.close();
  }
});
