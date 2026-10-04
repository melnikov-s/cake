import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("main Effect runtime starts with bounded memory and finalizes before Electron exits", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-main-lifecycle-"));
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

  const childProcess = application.process();
  try {
    const page = await application.firstWindow();
    await expect(page.locator("body")).toBeVisible({ timeout: 20_000 });
    const memory = await application.evaluate(() => process.memoryUsage());
    await test.info().attach("startup-memory", {
      body: JSON.stringify(memory),
      contentType: "application/json",
    });
    // A clean profile previously retained ~2.2 GiB of Layer scope bookkeeping.
    // Bound both live allocations and heap capacity without relying on forced GC or OS RSS.
    expect(memory.heapUsed).toBeLessThan(256 * 1024 * 1024);
    expect(memory.heapTotal).toBeLessThan(512 * 1024 * 1024);
    await application.close();
    expect(childProcess.exitCode).toBe(0);
  } finally {
    if (childProcess.exitCode === null) await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
