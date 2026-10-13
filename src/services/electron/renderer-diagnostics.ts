import { WebContentsView, type BrowserWindow } from "electron";

/** Console output remains in DevTools; mirror errors to stderr without depending on backend RPC. */
export function installRendererDiagnostics(window: BrowserWindow, onCrash: () => void) {
  window.webContents.on("console-message", (event) => {
    if (event.level !== "error") return;
    console.error(
      `[cake.renderer:${window.webContents.id}] ${event.message}\n${event.sourceId}:${event.lineNumber}`,
    );
    if (event.frame !== window.webContents.mainFrame) return;
    if (
      !event.message.startsWith("[cake] Renderer crashed:") &&
      !event.message.startsWith("[cake] Startup failed")
    )
      return;
    onCrash();
    // Native WebContentsViews paint above the renderer, including its HTML top layer.
    for (const child of window.contentView.children)
      if (child instanceof WebContentsView && child.webContents !== window.webContents)
        child.setVisible(false);
    if (process.env.CAKE_ELECTRON_SMOKE !== "1") {
      window.show();
      window.moveTop();
    }
  });
}
