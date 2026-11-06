import { createModifierTapTracker } from "../../contracts/application/modifier-tap";

/** Electron recognizes taps before Chromium, including embedded frames. Never dispatch twice. */
export function listenForModifierTap(onTap: (binding: string, event: KeyboardEvent) => void) {
  if (window.cake) return () => {};
  const tracker = createModifierTapTracker();
  const keyDown = (event: KeyboardEvent) => {
    tracker.input("keydown", event);
  };
  const keyUp = (event: KeyboardEvent) => {
    const binding = tracker.input("keyup", event);
    if (binding) onTap(binding, event);
  };
  const reset = () => tracker.reset();
  window.addEventListener("keydown", keyDown, true);
  window.addEventListener("keyup", keyUp, true);
  window.addEventListener("blur", reset);
  window.addEventListener("pointerdown", reset, true);
  document.addEventListener("visibilitychange", reset);
  return () => {
    window.removeEventListener("keydown", keyDown, true);
    window.removeEventListener("keyup", keyUp, true);
    window.removeEventListener("blur", reset);
    window.removeEventListener("pointerdown", reset, true);
    document.removeEventListener("visibilitychange", reset);
  };
}
