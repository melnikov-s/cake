import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("disconnected diagnostic pipes do not interrupt the hidden desktop app", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cake-stdio-errors-"));
  const application = await electron.launch({
    args: [repositoryRoot],
    cwd: repositoryRoot,
    env: {
      ...process.env,
      CAKE_ELECTRON_SMOKE: "1",
      CAKE_ELECTRON_USER_DATA: join(temporaryRoot, "user-data"),
      CAKE_HOME: join(temporaryRoot, "cake-home"),
      PI_CODING_AGENT_DIR: join(temporaryRoot, "cake-home", "pi"),
      PI_CODING_AGENT_SESSION_DIR: "",
    },
  });

  try {
    const page = await application.firstWindow();
    await page.getByRole("button", { name: "One-off chat", exact: true }).click();
    const composer = page.getByRole("combobox", { name: "Message", exact: true });
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await application.evaluate(({ dialog }) => {
      const failures: string[] = [];
      const dialogs: string[] = [];
      // A regression must fail the test without showing a native dialog on the user's desktop.
      process.on("uncaughtException", (error) => failures.push(error.message));
      dialog.showErrorBox = (title, content) => dialogs.push(`${title}: ${content}`);
      Object.assign(globalThis, { cakeStdioFailures: failures, cakeStdioDialogs: dialogs });
    });

    for (const channel of ["stdout", "stderr"] as const) {
      const reader = application.process()[channel];
      if (!reader) throw new Error(`Electron ${channel} is not piped`);
      reader.destroy();
      const code = await application.evaluate(
        (_electron, channel) =>
          new Promise<string | undefined>((resolve) => {
            // A real failed write, not a synthetic error event. No test error listener is
            // attached to the stream; only the production listener handles that event.
            process[channel].write("disconnected diagnostic output\n", (error) => {
              // The stream emits 'error' after the callback. Settle on the following turn
              // so any uncaught exception is recorded before checking the result.
              setImmediate(() => resolve((error as NodeJS.ErrnoException | undefined)?.code));
            });
          }),
        channel,
      );
      expect(code).toBe("EPIPE");
    }

    await application.evaluate(
      () =>
        new Promise<void>((resolve) => {
          process.emitWarning("Warning after diagnostic output disconnected");
          console.log("Log after diagnostic output disconnected");
          setImmediate(resolve);
        }),
    );
    expect(
      await application.evaluate(() => ({
        failures: Reflect.get(globalThis, "cakeStdioFailures"),
        dialogs: Reflect.get(globalThis, "cakeStdioDialogs"),
      })),
    ).toEqual({ failures: [], dialogs: [] });

    await composer.click();
    await page.keyboard.type("Still usable after output disconnect");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("Still usable after output disconnect");
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(
      await application.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused()),
      ),
    ).toBe(true);
  } finally {
    await application.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
