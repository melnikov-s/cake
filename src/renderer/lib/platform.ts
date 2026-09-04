/** Whether the renderer is running on macOS. */
export const isMacPlatform = /Mac/.test(navigator.userAgent);

/** Human-readable terminal toggle accelerator for the running platform. */
export const terminalToggleAcceleratorHint = isMacPlatform ? "⌘`" : "Ctrl+`";
