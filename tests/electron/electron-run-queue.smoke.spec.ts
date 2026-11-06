import { expect, test } from "@playwright/test";
import { _electron as electron } from "../../scripts/queued-electron.mjs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Verify the executable/inspector/stdio boundary without building or booting Cake.
test("the queued executable launches and closes one hidden isolated Electron application", async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-queue-electron-smoke-"));
  const entry = join(root, "main.cjs");
  await writeFile(
    entry,
    `
    const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(join(root, "user-data"))});
    app.whenReady().then(() => {
      const window = new BrowserWindow({ show: false });
      window.loadURL("data:text/html,<title>Queue smoke</title>");
    });
  `,
  );
  try {
    const application = await electron.launch({ args: [entry] });
    const childProcess = application.process();
    try {
      await application.firstWindow();
      expect(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().every(
            (window) => !window.isVisible() && !window.isFocused(),
          ),
        ),
      ).toBe(true);
      await application.close();
      expect(childProcess.exitCode).toBe(0);
    } finally {
      if (childProcess.exitCode === null) await application.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
