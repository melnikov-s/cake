import { mkdtemp, rm } from "node:fs/promises";
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

type RpcHarness = {
  getHomeDirectory(): Promise<string>;
  getApplicationState(): Promise<{
    projects: ReadonlyArray<unknown>;
  }>;
  listDiscussionSessions(): Promise<ReadonlyArray<unknown>>;
  invokeElectronProbe(): Promise<{ type: string }>;
  agentAvailability(): Promise<{ global: { state: string } }>;
  typedFailureTag(): Promise<string>;
  stream(count: number, intervalMs: number): Promise<ReadonlyArray<number>>;
  startDelay(durationMs: number): void;
  cancelDelay(): void;
  waitForDelay(): Promise<string>;
  startStream(count: number, intervalMs: number): void;
  activeRequests(): Promise<{ delays: number; streams: number }>;
};

async function openHarness(application: ElectronApplication, hash: string): Promise<Page> {
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

const callHarness = <A>(
  page: Page,
  method: keyof RpcHarness,
  ...args: ReadonlyArray<unknown>
): Promise<A> =>
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

test("Effect RPC crosses Electron with schemas, streams, interruption, and connection cleanup", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-effect-rpc-"));
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
      CAKE_HOME: join(temporaryRoot, "cake-home"),
    },
  });

  try {
    await application.firstWindow();
    const observer = await openHarness(application, "observer");

    expect(await callHarness<string>(observer, "getHomeDirectory")).toMatch(/^\//);
    expect(await callHarness(observer, "getApplicationState")).toMatchObject({
      projects: [],
    });
    expect(await callHarness(observer, "listDiscussionSessions")).toEqual([]);
    expect(await callHarness<{ requestId: string }>(observer, "invokeElectronProbe")).toMatchObject(
      { requestId: expect.any(String) },
    );
    expect(await callHarness(observer, "agentAvailability")).toMatchObject({
      global: { state: "available" },
    });
    expect(await callHarness<string>(observer, "typedFailureTag")).toBe("FoundationFailure");
    expect(await callHarness<ReadonlyArray<number>>(observer, "stream", 3, 1)).toEqual([1, 2, 3]);

    await callHarness<void>(observer, "startDelay", 30_000);
    await expect
      .poll(() => callHarness(observer, "activeRequests"))
      .toEqual({ delays: 1, streams: 0 });
    await callHarness<void>(observer, "cancelDelay");
    expect(await callHarness<string>(observer, "waitForDelay")).toBe("interrupted");
    await expect
      .poll(() => callHarness(observer, "activeRequests"))
      .toEqual({ delays: 0, streams: 0 });

    const closing = await openHarness(application, "cleanup");
    await callHarness<void>(closing, "startDelay", 30_000);
    await callHarness<void>(closing, "startStream", 100, 10_000);
    await expect
      .poll(() => callHarness(observer, "activeRequests"))
      .toEqual({ delays: 1, streams: 1 });
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith("#cleanup"))
        ?.destroy();
    });
    await expect
      .poll(() => callHarness(observer, "activeRequests"))
      .toEqual({ delays: 0, streams: 0 });
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
