import { expect, type ElectronApplication, type Page } from "@playwright/test";

/** Exercise the real boundary while independent DOM and native layers cover the application. */
export async function provokeRendererCrash(page: Page, application: ElectronApplication) {
  await expect(page.getByRole("button", { name: "Open settings", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const cover = document.createElement("dialog");
    cover.textContent = "Existing modal covering the application";
    document.body.append(cover);
    cover.showModal();
    // Fail a real React render when Settings creates its search input. The fallback uses no inputs.
    const original = document.createElement.bind(document);
    document.createElement = new Proxy(original, {
      apply(target, receiver, args) {
        if (args[0] === "input")
          throw new Error("Backend boundary regression: full diagnostic stack");
        return Reflect.apply(target, receiver, args);
      },
    });
  });
  await application.evaluate(async ({ BrowserWindow, WebContentsView }) => {
    const window = BrowserWindow.getAllWindows()[0]!;
    const cover = new WebContentsView();
    await cover.webContents.loadURL("data:text/html,<h1>Native view covering Cake</h1>");
    cover.setBounds({ x: 0, y: 0, width: 1180, height: 820 });
    window.contentView.addChildView(cover);
    cover.setVisible(true);
    Object.assign(globalThis, { rendererCrashCover: cover });
  });
  // The existing modal and native view intentionally cover the control being used to provoke the crash.
  await page.evaluate(() =>
    document.querySelector<HTMLButtonElement>('[aria-label="Open settings"]')!.click(),
  );
}
