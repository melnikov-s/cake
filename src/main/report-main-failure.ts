import { app, BrowserWindow, clipboard, dialog } from "electron";

/** Await acknowledgment before main tears down the runtime and exits. */
export async function reportMainFailure(details: string) {
  // Unattended test instances must exit instead of blocking on (and surfacing) a modal dialog.
  if (process.env.CAKE_ELECTRON_SMOKE === "1") {
    console.error("[cake.main] Fatal error", details);
    return;
  }
  await app.whenReady();
  const parent =
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => window.isVisible());
  const options = {
    type: "error" as const,
    title: "Cake encountered an error",
    message: "Cake could not continue and needs to close.",
    detail: details,
    buttons: ["Close Cake", "Copy error details"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  while (true) {
    const result =
      parent && !parent.isDestroyed()
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
    if (result.response !== 1) return;
    clipboard.writeText(details);
  }
}
