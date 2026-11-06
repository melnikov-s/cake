import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { callRpcHarness, openRpcHarness } from "./rpc-harness";

const repository = resolve(import.meta.dirname, "../..");

test("inspector evaluations survive collection after an awaited RPC result settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-evaluation-lifetime-"));
  let application: ElectronApplication | undefined;
  try {
    application = await electron.launch({
      args: [repository, "--js-flags=--expose-gc"],
      cwd: repository,
      env: {
        ...process.env,
        CAKE_ELECTRON_SMOKE: "1",
        CAKE_ELECTRON_USER_DATA: join(directory, "desktop"),
        CAKE_HOME: join(directory, "home"),
        PI_CODING_AGENT_DIR: join(directory, "home", "pi"),
        PI_CODING_AGENT_SESSION_DIR: "",
      },
    });
    const page = await application.firstWindow();
    await expect(page.getByRole("button", { name: "Cake Chat", exact: true })).toBeVisible();
    const harness = await openRpcHarness(application, "promise-lifetime");
    const expected = await callRpcHarness<string>(harness, "getHomeDirectory");
    for (let iteration = 0; iteration < 10; iteration++) {
      // V8 5177b10891 keeps the inspector result strong through delivery. Two
      // microtasks put collection after settlement, before Playwright receives it.
      const value = await harness.evaluate(async () => {
        const collect = Reflect.get(globalThis, "gc") as (() => void) | undefined;
        if (!collect) throw new Error("Garbage collection was not exposed");
        const rpc = Reflect.get(globalThis, "cakeRpcHarness") as {
          getHomeDirectory(): Promise<string>;
        };
        const result = await rpc.getHomeDirectory();
        queueMicrotask(() => queueMicrotask(collect));
        return result;
      });
      expect(value).toBe(expected);
    }
  } finally {
    await application?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
