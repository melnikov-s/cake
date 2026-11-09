import type { Display } from "electron";
import { runOsaScript } from "./selected-text";

/** Used only when the work area has no top inset (auto-hide/fullscreen) or is unavailable.
 * Match NSScreen by display ID, not index or desktop origin. No Accessibility permission is needed.
 */
const MENU_BAR_INSET_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  var screens = $.NSScreen.screens;
  for (var i = 0; i < screens.count; i++) {
    var screen = screens.objectAtIndex(i);
    if (String(screen.deviceDescription.objectForKey('NSScreenNumber').js) !== argv[0]) continue;
    var frame = screen.frame;
    var visible = screen.visibleFrame;
    // Reserve the potential menu-bar strip even while auto-hidden: it may be revealed in the still.
    return String(Math.max(
      $.NSStatusBar.systemStatusBar.thickness,
      screen.safeAreaInsets.top,
      frame.origin.y + frame.size.height - visible.origin.y - visible.size.height
    ));
  }
  throw new Error('Capture display is unavailable');
}
`;

/** Returns an exclusive top boundary in actual screenshot pixels; null disables only auto capture.
 * Only the top inset is used: the Dock and app window title bars are not excluded.
 */
export async function automaticCaptureTopInset(
  platform: string,
  display: Pick<Display, "id" | "bounds" | "workArea">,
  pixelHeight: number,
  signal: AbortSignal,
  runScript = runOsaScript,
): Promise<number | null> {
  if (platform !== "darwin") return 0;
  const { bounds, workArea } = display;
  if (!(bounds.height > 0) || !(pixelHeight > 0)) return null;
  let inset = workArea ? workArea.y - bounds.y : NaN;
  if (!(inset > 0 && inset < bounds.height)) {
    try {
      inset = Number(await runScript(MENU_BAR_INSET_SCRIPT, [String(display.id)], signal));
    } catch {
      return null;
    }
  }
  // Round inward; the bitmap may not have the requested display.scaleFactor.
  const pixels = Math.ceil((inset * pixelHeight) / bounds.height);
  return Number.isFinite(pixels) && pixels > 0 && pixels <= pixelHeight - 2 ? pixels : null;
}
