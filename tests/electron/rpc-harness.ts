import { join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";

const repositoryRoot = join(import.meta.dirname, "../..");

export async function openRpcHarness(
  application: ElectronApplication,
  hash: string,
): Promise<Page> {
  const opened = application.waitForEvent("window");
  const preloadError = await application.evaluate(
    async ({ BrowserWindow }, { hash, harnessPath, preloadPath }) => {
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let preloadError: string | undefined;
      window.webContents.on("preload-error", (_event, _path, error) => {
        preloadError = error.stack ?? error.message;
      });
      await window.loadFile(harnessPath, { hash });
      return preloadError;
    },
    {
      hash,
      harnessPath: join(repositoryRoot, "out/renderer/rpc-test-harness.html"),
      preloadPath: join(repositoryRoot, "out/preload/preload.cjs"),
    },
  );
  if (preloadError) throw new Error(preloadError);
  const page = await opened;
  await expect.poll(() => page.locator("html").getAttribute("data-rpc-ready")).toBe("true");
  return page;
}

export const callRpcHarness = <Result>(
  page: Page,
  method: string,
  ...args: ReadonlyArray<unknown>
): Promise<Result> =>
  page.evaluate(
    async ({ method, args }) => {
      const harness = Reflect.get(globalThis, "cakeRpcHarness") as Record<
        string,
        (...values: ReadonlyArray<unknown>) => unknown
      >;
      return (await harness[method]!(...args)) as Result;
    },
    { method, args },
  );
