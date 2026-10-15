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
 * Inside a main window the same keys keep their in-app meaning (Command+Backquote toggles the
 * terminal through the application menu); everywhere else, including the overlay itself, the
 * global registration owns them so one key both drops the overlay down and puts it away.
 */
export function overlayShortcutActive(accelerator: string, focus: CakeWindowFocus): boolean {
  return accelerator !== "" && focus !== "main";
}

/** A wide strip across the top of the display's work area, about 45% of its height. */
export function overlayBounds(workArea: Rectangle): Rectangle {
  const width = Math.min(
    workArea.width,
    Math.max(Math.min(760, workArea.width), Math.round(workArea.width * 0.8)),
  );
  const height = Math.min(
    workArea.height,
    Math.max(Math.min(360, workArea.height), Math.round(workArea.height * 0.45)),
  );
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y,
    width,
    height,
  };
}
