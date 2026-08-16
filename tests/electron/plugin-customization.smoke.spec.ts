import { _electron as electron, expect, test } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("builds, activates, persists, recovers, and disables a failed plugin renderer", async () => {
  test.setTimeout(90_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-plugin-smoke-"));
  const cakeHome = join(temporaryRoot, "cake-home");
  const userData = join(temporaryRoot, "user-data");
  const plugin = join(cakeHome, "plugins", "smoke.example");
  await Promise.all([mkdir(plugin, { recursive: true }), mkdir(userData, { recursive: true })]);
  await writeFile(join(plugin, "cake-plugin.json"), JSON.stringify({ schemaVersion: 2, id: "smoke.example", name: "Smoke Example", renderer: "index.tsx", backend: "backend.ts", scene: "scene.tsx", activeScene: true }));
  await writeFile(join(plugin, "backend.ts"), `import { execFile } from "node:child_process"; import { readFile } from "node:fs/promises"; import { promisify } from "node:util"; import { definePluginBackend } from "cake/backend"; const run = promisify(execFile); export default definePluginBackend({ methods: { async capabilities() { await readFile(new URL(import.meta.url)); const { stdout } = await run("git", ["--version"]); return { marker: "BACKEND_OK", git: stdout.trim() }; } } });\n`);
  const writePlugin = (label: string) => writeFile(join(plugin, "index.tsx"), `import { useState } from "react"; import { definePlugin, usePluginBackend } from "cake"; function Badge() { const backend = usePluginBackend("smoke.example"); const [result, setResult] = useState(""); return <button id="plugin-marker" onClick={() => void backend.call("capabilities").then((value) => setResult(JSON.stringify(value)))}>${label} {result}</button>; } export default definePlugin({ id: "smoke.example", contributions: { Badge }, slots: { "global.sidebar.header": [{ id: "badge", component: Badge }] } });\n`);
  await writePlugin("PLUGIN_V1");
  await writeFile(join(plugin, "scene.tsx"), `import { DefaultScene } from "cake"; export default function Scene() { return <DefaultScene />; }\n`);

  const application = await electron.launch({ args: [repositoryRoot], cwd: repositoryRoot, env: { ...process.env, CAKE_ELECTRON_SMOKE: "1", CAKE_ELECTRON_USER_DATA: userData, CAKE_HOME: cakeHome } });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const request = (input: unknown) => page.evaluate(async (payload) => (window as unknown as { cake: { request(value: unknown): Promise<unknown> } }).cake.request(payload), input);
    const validateAndActivate = async (input: Record<string, unknown> = {}) => {
      const validation = await request({ type: "validate-customization", ...input }) as { revision: string; sourceRevision: string; valid: boolean; diagnostics: unknown[] };
      if (!validation.valid) throw new Error(`Validation failed: ${JSON.stringify(validation.diagnostics)}`);
      await request({ type: "activate-customization", revision: validation.revision, expectedSourceRevision: validation.sourceRevision, request: input.request ?? "Smoke test activation" });
    };
    await validateAndActivate();
    await expect(page.locator("#plugin-marker")).toContainText("PLUGIN_V1", { timeout: 20_000 });
    await page.locator("#plugin-marker").click();
    await expect(page.locator("#plugin-marker")).toContainText("BACKEND_OK", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { pendingRevision?: string; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state)).toMatchObject({ pendingRevision: undefined, activeRevision: expect.any(String) });

    await page.evaluate(async () => {
      const bridge = (window as unknown as { cake: { request(input: unknown): Promise<{ record?: { value: unknown } }> } }).cake;
      await bridge.request({ type: "save-plugin-state", pluginId: "smoke.example", key: "selection", scope: { kind: "global" }, value: { day: 3 }, expectedVersion: 0 });
      const loaded = await bridge.request({ type: "load-plugin-state", pluginId: "smoke.example", key: "selection", scope: { kind: "global" } });
      if (JSON.stringify(loaded.record?.value) !== JSON.stringify({ day: 3 })) throw new Error("Plugin state did not round-trip");
    });

    const sourceV1 = await request({ type: "get-customization-state" }) as { state: { sourceRevision: string } };
    const filesV1 = await request({ type: "list-plugin-files" }) as { workingRevision: string; files: string[] };
    expect(filesV1.files).toContain("plugins/smoke.example/index.tsx");
    expect(await request({ type: "read-plugin-file", pluginId: "smoke.example", path: "index.tsx" })).toMatchObject({ content: expect.stringContaining("PLUGIN_V1") });
    const sourceV2 = `import { definePlugin } from "cake"; const Badge = () => <b id="plugin-marker">PLUGIN_V2</b>; export default definePlugin({ id: "smoke.example", contributions: { Badge }, slots: { "global.sidebar.header": [{ id: "badge", component: Badge }] } });\n`;
    const filesV2 = await request({ type: "write-plugin-file", pluginId: "smoke.example", path: "index.tsx", content: sourceV2, expectedWorkingRevision: filesV1.workingRevision }) as { buildRevision: string };
    await validateAndActivate({ expectedBaseRevision: sourceV1.state.sourceRevision, expectedSourceRevision: filesV2.buildRevision, request: "Upgrade smoke plugin to V2" });
    await expect(page.locator("#plugin-marker")).toContainText("PLUGIN_V2", { timeout: 20_000 });
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { pendingRevision?: string; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state)).toMatchObject({ pendingRevision: undefined, activeRevision: expect.any(String) });
    const activeV2 = await request({ type: "get-customization-state" }) as { state: { sourceRevision: string } };
    const filesBeforeCrash = await request({ type: "list-plugin-files" }) as { workingRevision: string };
    const broken = await request({ type: "write-plugin-file", pluginId: "smoke.example", path: "scene.tsx", content: `export default function Broken() { throw new Error("PLUGIN_RUNTIME_CRASH"); }\n`, expectedWorkingRevision: filesBeforeCrash.workingRevision }) as { buildRevision: string };
    await validateAndActivate({ expectedBaseRevision: activeV2.state.sourceRevision, expectedSourceRevision: broken.buildRevision, request: "Exercise runtime recovery" });
    const recovery = page.locator("[aria-label='Customization recovery']");
    await expect(recovery).toContainText("Smoke Example failed to load", { timeout: 20_000 });
    await expect(recovery.getByRole("button")).toHaveText(["Disable for now", "Repair"]);
    await recovery.getByRole("button", { name: "Disable for now" }).click();
    await expect.poll(() => page.evaluate(async () => (await (window as unknown as { cake: { request(input: unknown): Promise<{ state?: { recoveryRequired?: boolean; activeRevision?: string } }> } }).cake.request({ type: "get-customization-state" })).state), { timeout: 20_000 }).toMatchObject({ recoveryRequired: false, activeRevision: expect.any(String) });
    await expect(recovery).toHaveCount(0);
    await expect(page.locator("#plugin-marker")).toHaveCount(0);
    await expect.poll(async () => request({ type: "list-plugins" })).toMatchObject({ plugins: [expect.objectContaining({ id: "smoke.example", enabled: false })] });
  } finally {
    await application.close();
  }
});
