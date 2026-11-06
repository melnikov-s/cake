import { describe, expect, it } from "vitest";
import {
  createModifierTapTracker,
  type ModifierTapInput,
} from "../../../src/contracts/application/modifier-tap";
import { cakeHotkeyActionIds } from "../../../src/contracts/application/cake-settings-data";
import {
  hotkeyDefinitions,
  formatHotkey,
  hotkeyFromKeyboardEvent,
} from "../../../src/renderer/lib/hotkeys";

const input = (code: string, changes: Partial<ModifierTapInput> = {}): ModifierTapInput => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...changes,
});

describe("standalone side-specific Option/Alt taps", () => {
  it("completes only on release, once, and keeps the two sides distinct", () => {
    const tracker = createModifierTapTracker(() => 0);
    expect(tracker.input("keydown", input("AltRight", { altKey: true }))).toBeUndefined();
    expect(tracker.input("keyup", input("AltRight"))).toBe("AltRight");
    expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    tracker.input("keydown", input("AltLeft", { altKey: true }));
    expect(tracker.input("keyup", input("AltLeft"))).toBe("AltLeft");
    expect(formatHotkey("AltRight")).toMatch(/^Right (Option|Alt)$/);
    expect(formatHotkey("AltLeft")).toMatch(/^Left (Option|Alt)$/);
    expect(
      hotkeyFromKeyboardEvent({ key: "Alt", ...input("AltRight", { altKey: true }) }),
    ).toBeUndefined();
    expect(
      hotkeyFromKeyboardEvent({ key: "Alt", ...input("AltRight"), modifierTap: "AltRight" }),
    ).toBe("AltRight");
  });

  it.each(["KeyE", "KeyQ", "ShiftLeft", "AltLeft"])(
    "rejects chords and alternate-character typing with %s",
    (code) => {
      const tracker = createModifierTapTracker(() => 0);
      tracker.input("keydown", input("AltRight", { altKey: true }));
      tracker.input("keydown", input(code, { altKey: true }));
      tracker.input("keyup", input(code, { altKey: true }));
      expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
      tracker.input("keydown", input(code));
      tracker.input("keydown", input("AltRight", { altKey: true }));
      expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    },
  );

  it("rejects long holds, repeat, composition, other modifiers, and release after lost focus", () => {
    let now = 0;
    const tracker = createModifierTapTracker(() => now);
    tracker.input("keydown", input("AltRight", { altKey: true }));
    now = 301;
    expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    tracker.input("keydown", input("AltRight", { altKey: true }));
    tracker.input("keydown", input("AltRight", { altKey: true, repeat: true }));
    expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    for (const flags of [
      { isComposing: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      tracker.input("keydown", input("AltRight", flags));
      expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    }
    tracker.input("keydown", input("AltRight", { altKey: true }));
    tracker.reset();
    expect(tracker.input("keyup", input("AltRight"))).toBeUndefined();
    tracker.input("keydown", input("AltRight", { altKey: true }));
    expect(tracker.input("keyup", input("AltRight"))).toBe("AltRight");
  });

  it("exposes every registered action exactly once and leaves dictation mute unbound", () => {
    expect(hotkeyDefinitions.map(({ id }) => id).sort()).toEqual([...cakeHotkeyActionIds].sort());
    expect(hotkeyDefinitions.find(({ id }) => id === "toggle-dictation-mute")?.defaultBinding).toBe(
      "",
    );
  });
});
