import { describe, expect, it } from "vitest";
import {
  addPresentationModeReminder,
  presentationModeFromReminder,
  stripPresentationModeReminder,
} from "../../../src/contracts/conversations/presentation-mode-reminders";
import { projectQueuedMessages } from "../../../src/services/pi/runtime/session-projection";

const reminder = (from: "normal" | "vscode" | "browser", to: "normal" | "vscode" | "browser") =>
  addPresentationModeReminder("Keep working", from, to);

describe("presentation mode reminders", () => {
  it("does not add a reminder when the mode is unchanged", () => {
    expect(reminder("normal", "normal")).toBe("Keep working");
    expect(reminder("vscode", "vscode")).toBe("Keep working");
    expect(reminder("browser", "browser")).toBe("Keep working");
  });

  it("describes every supported presentation transition", () => {
    expect(reminder("normal", "vscode")).toContain("entered embedded VS Code");
    expect(reminder("normal", "browser")).toContain("entered Browser Mode");
    expect(reminder("vscode", "normal")).toContain("returned to the normal conversation view");
    expect(reminder("browser", "normal")).toContain("returned to the normal conversation view");
    expect(reminder("vscode", "browser")).toContain("entered Browser Mode");
    expect(reminder("browser", "vscode")).toContain("entered embedded VS Code");
  });

  it("recovers the resulting mode and strips the hidden reminder from presentation text", () => {
    const content = reminder("browser", "vscode");
    expect(presentationModeFromReminder(content)).toBe("vscode");
    expect(stripPresentationModeReminder(content)).toBe("Keep working");
    expect(projectQueuedMessages([], [content])[0]).toMatchObject({
      kind: "text",
      role: "user",
      text: "Keep working",
    });
  });
});
