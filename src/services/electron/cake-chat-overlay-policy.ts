/** Which kind of Cake window, if any, currently has keyboard focus. */
export type CakeWindowFocus = "none" | "main" | "overlay" | "other";

interface Rectangle {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The system-wide drop-down shortcut is registered only while no main Cake window is focused.
 * Inside a main window the application-menu accelerator toggles the same overlay, including
 * when an embedded editor or browser owns keyboard input. Elsewhere the global registration
 * owns the keys, including the non-activating overlay panel.
 */
export function overlayShortcutActive(accelerator: string, focus: CakeWindowFocus): boolean {
  return accelerator !== "" && focus !== "main";
}

/** A wide strip across the top of the display's work area, about 45% of its height. */
export function overlayBounds(workArea: Rectangle): Rectangle {
  const height = Math.min(
    workArea.height,
    Math.max(Math.min(360, workArea.height), Math.round(workArea.height * 0.45)),
  );
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height,
  };
}
