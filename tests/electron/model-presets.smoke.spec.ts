import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

interface Preset {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  fastMode: boolean;
}

interface Projection {
  presets: ReadonlyArray<Preset>;
  defaultPresetId?: string;
}

async function launch(temporaryRoot: string) {
  return electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });
}

async function openHarness(application: ElectronApplication): Promise<Page> {
  const opened = application.waitForEvent("window");
  await application.evaluate(
    async ({ BrowserWindow }, { harnessPath, preloadPath }) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      await window.loadFile(harnessPath, { hash: "model-presets" });
    },
    {
      harnessPath: join(repositoryRoot, "out/renderer/rpc-test-harness.html"),
      preloadPath: join(repositoryRoot, "out/preload/preload.cjs"),
    },
  );
  const page = await opened;
  await expect.poll(() => page.locator("html").getAttribute("data-rpc-ready")).toBe("true");
  return page;
}

const call = <A>(page: Page, method: string, ...args: ReadonlyArray<unknown>): Promise<A> =>
  page.evaluate(
    async ({ method, args }) => {
      const harness = Reflect.get(globalThis, "cakeRpcHarness") as Record<
        string,
        (...values: ReadonlyArray<unknown>) => unknown
      >;
      return (await harness[method]!(...args)) as A;
    },
    { method, args },
  );

test("Model Presets use Effect RPC, persist transactionally, and preserve unresolved references", async () => {
  test.setTimeout(60_000);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-model-presets-"));
  const userData = join(temporaryRoot, "user-data");
  const project = join(temporaryRoot, "project");
  await Promise.all([mkdir(userData, { recursive: true }), mkdir(project, { recursive: true })]);
  await writeFile(
    join(userData, "application.json"),
    JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          path: project,
          name: "project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
      resolvedSessionIds: [],
      trustedProjectPaths: [],
    }),
  );
  await writeFile(
    join(userData, "window-state.json"),
    JSON.stringify({
      projectPath: project,
      recentProjectPaths: [project],
      draft: "",
      theme: "system",
    }),
  );
  let application = await launch(temporaryRoot);
  try {
    await application.firstWindow();
    const harness = await openHarness(application);
    expect(await call<Projection>(harness, "listModelPresets")).toEqual({ presets: [] });

    const created = await call<Projection>(harness, "createModelPreset", {
      name: "Unavailable preset",
      provider: "missing-provider",
      modelId: "missing-model",
      thinkingLevel: "high",
      fastMode: false,
    });
    const unavailable = created.presets[0]!;
    expect(unavailable.id).toMatch(/^[0-9a-f-]{36}$/);

    const updated = await call<Projection>(harness, "updateModelPreset", {
      ...unavailable,
      name: "Unavailable but editable",
    });
    expect(updated.presets[0]!.name).toBe("Unavailable but editable");
    expect(await call<string>(harness, "resolveModelPresetFailureTag", unavailable.id)).toBe(
      "UnknownPiModelError",
    );

    const withDefault = await call<Projection>(harness, "setDefaultModelPreset", unavailable.id);
    expect(withDefault.defaultPresetId).toBe(unavailable.id);

    const withDuplicate = await call<Projection>(harness, "createModelPreset", {
      name: "Temporary second preset",
      provider: "missing-provider",
      modelId: "other-missing-model",
      thinkingLevel: "off",
      fastMode: false,
    });
    expect(withDuplicate.presets).toHaveLength(2);
    const removed = await call<Projection>(
      harness,
      "removeModelPreset",
      withDuplicate.presets[1]!.id,
    );
    expect(removed.presets).toHaveLength(1);

    await application.close();
    // Start the verification window with one genuinely new staged Project chat;
    // the first renderer may have snapshotted its pre-mutation pending configuration.
    await writeFile(
      join(userData, "window-state.json"),
      JSON.stringify({
        projectPath: project,
        recentProjectPaths: [project],
        draft: "",
        theme: "system",
      }),
    );
    application = await launch(temporaryRoot);
    const mainPage = await application.firstWindow();
    const restartedHarness = await openHarness(application);
    expect(await call<Projection>(restartedHarness, "listModelPresets")).toEqual({
      presets: [
        {
          ...unavailable,
          name: "Unavailable but editable",
        },
      ],
      defaultPresetId: unavailable.id,
    });

    await expect(mainPage.getByLabel("Message")).toBeVisible({ timeout: 20_000 });
    await mainPage.getByRole("button", { name: "New chat in project", exact: true }).click();
    await expect(mainPage.getByRole("button", { name: "Model configuration" })).toContainText(
      "Unavailable but editable",
    );
    await mainPage.getByRole("button", { name: "New Cake Chat" }).first().click();
    await expect(mainPage.getByLabel("Message Cake Chat")).toBeVisible();
    await expect(mainPage.getByRole("button", { name: "Model configuration" })).toContainText(
      "Unavailable but editable",
    );

    const openSettings = mainPage.getByLabel("Open settings").first();
    await expect(openSettings).toBeVisible({ timeout: 20_000 });
    await openSettings.click();
    const modelPresets = mainPage.getByLabel("Model Presets");
    await expect(modelPresets.getByText("Unavailable but editable", { exact: true })).toBeVisible();
    await expect(modelPresets.getByText("Model unavailable", { exact: true })).toBeVisible();
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
