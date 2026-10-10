import { describe, expect, it } from "vitest";
import {
  addResponseModeReminder,
  stripResponseModeReminder,
  responseModeReminders,
  responseModeFromReminder,
} from "../../../src/services/pi/response-mode-reminders";
import {
  addPresentationModeReminder,
  stripPresentationModeReminder,
} from "../../../src/services/pi/presentation-mode-reminders";

describe("conversation response-mode contract", () => {
  it("voice input receives the approved brief spoken-response guidance without changing its visible text", () => {
    const decorated = addResponseModeReminder("Hello", "voice");
    expect(decorated).toBe(`Hello\n\n${responseModeReminders.voice}`);
    expect(stripResponseModeReminder(decorated)).toBe("Hello");
  });
  it("recognizes response transitions only at exact injection boundaries", () => {
    expect(responseModeFromReminder("Plain text")).toBeUndefined();
    for (const mode of ["text", "voice"] as const) {
      expect(responseModeFromReminder(addResponseModeReminder("Next", mode))).toBe(mode);
      expect(
        responseModeFromReminder(
          `${addResponseModeReminder("Image", mode)}\n\n[Image converted from image/heic to image/png.]`,
        ),
      ).toBe(mode);
      expect(
        responseModeFromReminder(`${responseModeReminders[mode]}\n\nQuoted prose`),
      ).toBeUndefined();
      expect(
        responseModeFromReminder(
          responseModeReminders[mode].replace("Cake response mode", "User response mode"),
        ),
      ).toBeUndefined();
    }
    // Quoted voice guidance before a genuine text transition must not report voice.
    expect(
      responseModeFromReminder(
        addResponseModeReminder(`${responseModeReminders.voice}\n\nQuote`, "text"),
      ),
    ).toBe("text");
  });
  it("only exact Cake-owned response-mode reminders are stripped; user reminder tags survive", () => {
    const own = "<system-reminder>User supplied guidance.</system-reminder>";
    expect(stripResponseModeReminder(own)).toBe(own);
    expect(stripResponseModeReminder(addResponseModeReminder(own, "voice"))).toBe(own);
    expect(
      stripResponseModeReminder(
        responseModeReminders.voice.replace("Reply briefly", "Reply slowly"),
      ),
    ).toContain("Reply slowly");
  });
  it("strips exact response guidance before Pi normalization hints while preserving hints and unrelated tags", () => {
    const hints = [
      "[Image: original 4096x3072, displayed at 2048x1536. Multiply coordinates by 2.00 to map to original image.]",
      "[Image converted from image/heic to image/png.]",
      "[Image omitted: could not be converted to a supported inline image format.]",
      "[Image omitted: could not be resized below the inline image size limit.]",
    ];
    const own = "<system-reminder>User supplied guidance.</system-reminder>";
    for (const mode of ["voice", "text"] as const) {
      for (const hint of [...hints, hints.join("\n")]) {
        const body = `Question\n\n${own}`;
        expect(stripResponseModeReminder(`${addResponseModeReminder(body, mode)}\n\n${hint}`)).toBe(
          `${body}\n\n${hint}`,
        );
        expect(stripResponseModeReminder(`${responseModeReminders[mode]}\n\n${hint}`)).toBe(hint);
      }
      const quoted = `Question\n\n${responseModeReminders[mode]}\n\nUnrelated following prose`;
      expect(stripResponseModeReminder(quoted)).toBe(quoted);
      const partial = `Question${responseModeReminders[mode]}\n\n${hints[0]}`;
      expect(stripResponseModeReminder(partial)).toBe(partial);
      const altered = `Question\n\n${responseModeReminders[mode].replace("Cake response mode", "User response mode")}\n\n${hints[0]}`;
      expect(stripResponseModeReminder(altered)).toBe(altered);
    }
  });
  it("response style remains independent of normal, VS Code, Draw and browser presentation modes", () => {
    for (const mode of ["normal", "vscode", "draw", "browser"] as const) {
      const text = addResponseModeReminder(
        addPresentationModeReminder("Hello", "browser", mode),
        "voice",
      );
      expect(stripResponseModeReminder(stripPresentationModeReminder(text))).toBe("Hello");
      expect(text).toContain(responseModeReminders.voice);
    }
  });
});
